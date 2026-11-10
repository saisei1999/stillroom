/**
 * Two-device account-sync convergence test.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * This file composes the REAL storage layer (`src/storage.ts`), the REAL sync
 * transport/engine (`src/account-sync.ts`) and the REAL pure domain logic
 * (`src/sync-core.ts`, via `src/sync-control.ts` for conflict resolution) across
 * two simulated devices that only talk to each other through an in-memory fake
 * server. `mergeLibraryEntries` (`src/library-view.ts`) is used to assert what
 * each device would actually display, rather than poking at cache internals.
 *
 * The fake server below is a MODEL OF THE DOCUMENTED RPC CONTRACT only: it
 * mirrors the behaviour described in the comments of
 * `supabase/migrations/0001_account_sync.sql` and in `src/account-sync.ts`
 * (revision checks, create-only-at-revision-0, operation-id idempotency,
 * tombstones, resurrection, `sync_seq` paging, account partitioning).
 *
 * It does NOT prove the SQL migration, the PL/pgSQL function bodies, the RLS
 * policies, the ACL assertions, the advisory locking or the real Postgres /
 * Supabase stack behave this way. It also does not exercise real HTTP, JWTs or
 * IndexedDB implementations: each device uses the real `fake-indexeddb` package,
 * but that is still an in-memory IndexedDB, not a browser or Node database.
 *
 * `SYNC_ENABLED` deliberately stays `false`: these scenarios drive `syncPending`
 * directly (the same engine `runSync` would call), so they do not turn the
 * product's sync flag on and do not imply the live migration has been applied.
 *
 * DEVICE SIMULATION
 * `src/storage.ts` reads `globalThis.indexedDB` on every call, so a simulated
 * device is just its own `IDBFactory`. Switching devices closes the current
 * database connection first (`closeDatabase()`), then points the global factory
 * at the other device; two devices never share a factory. A "reload" is the same
 * close + reopen against the SAME factory, so the device's data survives while
 * the in-memory connection is rebuilt.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  closeDatabase,
  getAccountEntry,
  listAccountEntries,
  listConflicts,
  listPending,
  type Entry,
} from '../src/storage';
import { syncPending, type TransportClient } from '../src/account-sync';
import { mergeLibraryEntries } from '../src/library-view';
import { queueAccountDelete, queueAccountSave, resolveConflictKeepBoth } from '../src/sync-control';

const entryOf = (id: string, title = id): Entry => ({
  id,
  title,
  type: 'Book',
  status: 'Planned',
  color: 'blue',
  progress: '',
  tags: ['t'],
  notes: '',
  createdAt: '2026-01-01T00:00:00.000Z',
});

// ---------------------------------------------------------------------------
// Fake server: an in-memory model of the documented RPC contract.
// ---------------------------------------------------------------------------

type FaultMode = 'offline' | 'server' | 'auth';
type FaultedRpc = 'list_account_entries' | 'apply_entry_change';

type ServerRowState = {
  id: string;
  revision: number;
  payload: Record<string, unknown>;
  deleted: boolean;
  sync_seq: number;
  updated_at: string;
};

type OperationState = {
  entryId: string;
  expectedRevision: number;
  payloadHash: string;
  deleted: boolean;
  producedRevision: number;
};

type ApplyResultRow = {
  outcome: 'applied' | 'already_applied' | 'conflict';
  revision: number;
  payload: Record<string, unknown>;
  deleted: boolean;
  applied_revision: number | null;
};

type RpcReply = { data: unknown; error: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical JSON (sorted keys) so a retried payload hashes identically. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

class FakeSyncServer {
  private readonly rowsByAccount = new Map<string, Map<string, ServerRowState>>();
  private readonly operationsByAccount = new Map<string, Map<string, OperationState>>();
  private readonly faults = new Map<FaultedRpc, FaultMode>();
  /** The global pull cursor; unique across accounts, so still monotonic per account. */
  private nextSeq = 1;

  /**
   * Makes every subsequent call to one RPC fail: `offline` rejects the transport
   * with a network error, `server` returns a transient 5xx, `auth` returns a 401.
   * Pass `null` to heal the server.
   */
  fault(rpc: FaultedRpc, mode: FaultMode | null): void {
    if (mode === null) this.faults.delete(rpc);
    else this.faults.set(rpc, mode);
  }

  /** The stored row for one account entry, or undefined when the account has none. */
  row(accountId: string, entryId: string): ServerRowState | undefined {
    return this.rowsByAccount.get(accountId)?.get(entryId);
  }

  /** All stored rows for one account (tombstones included), ordered by `sync_seq`. */
  rowsFor(accountId: string): ServerRowState[] {
    const rows = this.rowsByAccount.get(accountId);
    if (!rows) return [];
    return [...rows.values()].sort((left, right) => left.sync_seq - right.sync_seq);
  }

  async rpc(accountId: string, fn: string, args: Record<string, unknown>): Promise<RpcReply> {
    if (fn === 'list_account_entries') {
      const fault = this.faultReply('list_account_entries');
      if (fault) return fault;
      return { data: this.list(accountId, args.p_after_seq, args.p_limit), error: null };
    }
    if (fn === 'apply_entry_change') {
      const fault = this.faultReply('apply_entry_change');
      if (fault) return fault;
      const applied = this.apply(accountId, args);
      if (applied.error !== undefined) return { data: null, error: applied.error };
      return { data: [applied.row], error: null };
    }
    return { data: null, error: { code: 'PGRST202', message: `Could not find the function ${fn}` } };
  }

  private faultReply(rpc: FaultedRpc): RpcReply | null {
    const mode = this.faults.get(rpc);
    if (mode === undefined) return null;
    if (mode === 'offline') throw new TypeError('Failed to fetch: the simulated device is offline.');
    if (mode === 'server') return { data: null, error: { code: 'pgrst999', message: 'service unavailable', status: 503 } };
    return { data: null, error: { code: 'pgrst301', message: 'jwt expired', status: 401 } };
  }

  /**
   * `list_account_entries`: caller-owned rows (tombstones included), ordered by
   * ascending `sync_seq`, filtered `sync_seq > p_after_seq`, limit clamped 1..500.
   */
  private list(accountId: string, afterSeq: unknown, limit: unknown): ServerRowState[] {
    // sync_seq starts at 1, so -1 is "from the beginning" for a null cursor.
    const after = typeof afterSeq === 'number' && Number.isSafeInteger(afterSeq) ? afterSeq : -1;
    const requested = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : 500;
    const clamped = Math.min(Math.max(requested, 1), 500);
    return this.rowsFor(accountId)
      .filter((row) => row.sync_seq > after)
      .slice(0, clamped)
      .map((row) => ({ ...row, payload: { ...row.payload } }));
  }

  /**
   * `apply_entry_change`: one atomic, revision-checked, idempotent write.
   * Mirrors the documented outcomes `applied` / `already_applied` / `conflict`
   * and the 22023 validation errors. See the migration comments for the rules.
   */
  private apply(accountId: string, args: Record<string, unknown>): { row?: ApplyResultRow; error?: unknown } {
    const id = args.p_id;
    const operationId = args.p_operation_id;
    const expectedRevision = args.p_expected_revision;
    const payload = args.p_payload;
    const deleted = args.p_deleted;

    if (typeof id !== 'string' || id.length === 0 || typeof operationId !== 'string' || operationId.length === 0) {
      return { error: { code: '22023', message: 'Invalid operation parameters' } };
    }
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return { error: { code: '22023', message: 'Invalid expected revision' } };
    }
    if (typeof deleted !== 'boolean' || !isPlainObject(payload)) {
      return { error: { code: '22023', message: 'Invalid payload' } };
    }
    const payloadHash = canonicalJson(payload);
    if (new TextEncoder().encode(payloadHash).length > 262144) {
      return { error: { code: '22023', message: 'Payload too large' } };
    }

    const operations = this.operationsByAccount.get(accountId) ?? new Map<string, OperationState>();
    this.operationsByAccount.set(accountId, operations);

    // Idempotency comes first: a retried operation never applies twice.
    const prior = operations.get(operationId);
    if (prior) {
      if (prior.entryId !== id || prior.expectedRevision !== expectedRevision || prior.payloadHash !== payloadHash || prior.deleted !== deleted) {
        return { error: { code: '22023', message: 'Operation ID was already used for different content' } };
      }
      const current = this.rowsByAccount.get(accountId)?.get(id);
      if (current) {
        // Report the row's CURRENT state, not the stale values this operation wrote.
        return {
          row: {
            outcome: 'already_applied',
            revision: current.revision,
            payload: { ...current.payload },
            deleted: current.deleted,
            applied_revision: prior.producedRevision,
          },
        };
      }
      return { row: { outcome: 'already_applied', revision: 0, payload: {}, deleted: true, applied_revision: prior.producedRevision } };
    }

    const rows = this.rowsByAccount.get(accountId) ?? new Map<string, ServerRowState>();
    this.rowsByAccount.set(accountId, rows);

    const current = rows.get(id);
    if (current) {
      // Includes expected_revision 0 against an existing row: conflict, never an overwrite.
      if (current.revision !== expectedRevision) {
        return {
          row: {
            outcome: 'conflict',
            revision: current.revision,
            payload: { ...current.payload },
            deleted: current.deleted,
            applied_revision: null,
          },
        };
      }
    } else if (expectedRevision !== 0) {
      // A non-create write against a row that does not exist.
      return { row: { outcome: 'conflict', revision: 0, payload: {}, deleted: false, applied_revision: null } };
    }

    // A tombstoned row is not special on the write path: matching the tombstone
    // revision applies an ordinary update (revision + 1, deleted becomes false),
    // which is the documented resurrection rule.
    const revision = current ? current.revision + 1 : 1;
    const storedPayload: Record<string, unknown> = deleted ? {} : { ...payload };
    const row: ServerRowState = {
      id,
      revision,
      payload: storedPayload,
      deleted,
      sync_seq: this.nextSeq++,
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    rows.set(id, row);
    operations.set(operationId, {
      entryId: id,
      expectedRevision,
      payloadHash,
      deleted,
      producedRevision: revision,
    });
    return { row: { outcome: 'applied', revision, payload: { ...storedPayload }, deleted, applied_revision: revision } };
  }
}

// ---------------------------------------------------------------------------
// Harness helpers.
// ---------------------------------------------------------------------------

/** Each simulated device owns a private IndexedDB factory; they are never shared. */
const newDeviceFactory = (): IDBFactory => new IDBFactory();

/** Closes the current device's database and points storage at `factory`. */
function activateDevice(factory: IDBFactory): void {
  closeDatabase();
  globalThis.indexedDB = factory;
}

function clientFor(server: FakeSyncServer, accountId: string): TransportClient {
  return {
    rpc: async <R>(fn: string, args: Record<string, unknown>) => (await server.rpc(accountId, fn, args)) as { data: R | null; error: unknown },
    currentUserId: async () => accountId,
  };
}

function syncDevice(server: FakeSyncServer, accountId: string) {
  return syncPending(clientFor(server, accountId), accountId);
}

/** What this device's gallery would show for `accountId`. */
async function displayedLibrary(accountId: string, localEntries: Entry[] = []): Promise<Entry[]> {
  return mergeLibraryEntries(localEntries, await listAccountEntries(accountId), accountId);
}

const titlesOf = (entries: Entry[]): string[] => entries.map((entry) => entry.title);

/** Queues an ordinary edit based on the revision this device last acknowledged. */
async function editEntry(accountId: string, entryId: string, title: string): Promise<void> {
  const cached = await getAccountEntry(accountId, entryId);
  await queueAccountSave(accountId, entryOf(entryId, title), cached?.revision ?? 0);
}

const ACCOUNT = 'account-one';

type ConvergenceContext = { server: FakeSyncServer; deviceA: IDBFactory; deviceB: IDBFactory; accountId: string };

function convergenceContext(): ConvergenceContext {
  return { server: new FakeSyncServer(), deviceA: newDeviceFactory(), deviceB: newDeviceFactory(), accountId: ACCOUNT };
}

/** A creates and syncs, B pulls, then both edit the same entry while offline. */
async function seedDivergedConflict(context: ConvergenceContext): Promise<void> {
  activateDevice(context.deviceA);
  await queueAccountSave(context.accountId, entryOf('e1', 'Created on A'), 0);
  await syncDevice(context.server, context.accountId);

  activateDevice(context.deviceB);
  await syncDevice(context.server, context.accountId);

  context.server.fault('list_account_entries', 'offline');
  context.server.fault('apply_entry_change', 'offline');
  activateDevice(context.deviceA);
  await editEntry(context.accountId, 'e1', 'Edited on A');
  activateDevice(context.deviceB);
  await editEntry(context.accountId, 'e1', 'Edited on B');
  context.server.fault('list_account_entries', null);
  context.server.fault('apply_entry_change', null);

  activateDevice(context.deviceA);
  await syncDevice(context.server, context.accountId);
  activateDevice(context.deviceB);
  await syncDevice(context.server, context.accountId);
}

beforeEach(() => {
  closeDatabase();
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => closeDatabase());

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

describe('two-device sync > create and pull', () => {
  it('A creates an entry and syncs; B pulls it and displays it', async () => {
    const server = new FakeSyncServer();
    const deviceA = newDeviceFactory();
    const deviceB = newDeviceFactory();

    activateDevice(deviceA);
    await queueAccountSave(ACCOUNT, entryOf('e1', 'Created on A'), 0);
    const firstSync = await syncDevice(server, ACCOUNT);
    expect(firstSync.pushed).toBe(1);
    expect(firstSync.pulled).toBe(0);
    expect(server.row(ACCOUNT, 'e1')).toMatchObject({ revision: 1, deleted: false, payload: { title: 'Created on A' } });
    expect(titlesOf(await displayedLibrary(ACCOUNT))).toContain('Created on A');

    activateDevice(deviceB);
    const secondSync = await syncDevice(server, ACCOUNT);
    expect(secondSync.pulled).toBe(1);
    expect(secondSync.pushed).toBe(0);
    expect(await listPending(ACCOUNT)).toEqual([]);
    expect((await getAccountEntry(ACCOUNT, 'e1'))?.revision).toBe(1);
    expect(titlesOf(await displayedLibrary(ACCOUNT))).toContain('Created on A');
  });
});

describe('two-device sync > offline edit and reload', () => {
  it('B keeps an offline edit through a reload and syncs it once the server answers again', async () => {
    const server = new FakeSyncServer();
    const deviceA = newDeviceFactory();
    const deviceB = newDeviceFactory();

    activateDevice(deviceA);
    await queueAccountSave(ACCOUNT, entryOf('e1', 'Created on A'), 0);
    await syncDevice(server, ACCOUNT);

    activateDevice(deviceB);
    await syncDevice(server, ACCOUNT); // B now knows revision 1.

    // The server becomes unreachable; the edit is still saved on this device.
    server.fault('list_account_entries', 'offline');
    server.fault('apply_entry_change', 'offline');
    await editEntry(ACCOUNT, 'e1', 'Edited offline on B');
    await expect(syncDevice(server, ACCOUNT)).rejects.toThrow(/offline|failed to fetch/i);
    expect((await listPending(ACCOUNT))[0]?.entry?.title).toBe('Edited offline on B');
    expect(titlesOf(await displayedLibrary(ACCOUNT))).toContain('Edited offline on B');

    // Simulated reload: close the connection and reopen the SAME device database.
    activateDevice(deviceB);
    const pendingAfterReload = await listPending(ACCOUNT);
    expect(pendingAfterReload).toHaveLength(1);
    expect(pendingAfterReload[0].entry?.title).toBe('Edited offline on B');

    server.fault('list_account_entries', null);
    server.fault('apply_entry_change', null);
    const report = await syncDevice(server, ACCOUNT);
    expect(report.pushed).toBe(1);
    expect(await listPending(ACCOUNT)).toEqual([]);
    expect(server.row(ACCOUNT, 'e1')).toMatchObject({ revision: 2, deleted: false, payload: { title: 'Edited offline on B' } });

    // A now pulls the edit B queued while offline.
    activateDevice(deviceA);
    await syncDevice(server, ACCOUNT);
    expect(titlesOf(await displayedLibrary(ACCOUNT))).toContain('Edited offline on B');
  });
});

describe('two-device sync > deletion tombstones', () => {
  it('A deletes an entry; B pulls the tombstone and no longer displays it or a stale local copy', async () => {
    const server = new FakeSyncServer();
    const deviceA = newDeviceFactory();
    const deviceB = newDeviceFactory();

    activateDevice(deviceA);
    await queueAccountSave(ACCOUNT, entryOf('e1', 'Created on A'), 0);
    await syncDevice(server, ACCOUNT);

    activateDevice(deviceB);
    await syncDevice(server, ACCOUNT);

    activateDevice(deviceA);
    await queueAccountDelete(ACCOUNT, 'e1');
    const deleteSync = await syncDevice(server, ACCOUNT);
    expect(deleteSync.pushed).toBe(1);
    expect(server.row(ACCOUNT, 'e1')).toMatchObject({ revision: 2, deleted: true, payload: {} });
    expect(titlesOf(await displayedLibrary(ACCOUNT))).toEqual([]);

    activateDevice(deviceB);
    const pullSync = await syncDevice(server, ACCOUNT);
    expect(pullSync.pulled).toBe(1);
    expect(pullSync.pushed).toBe(0);
    expect(await listPending(ACCOUNT)).toEqual([]);

    // B's cache holds the tombstone and its gallery shows nothing.
    const cached = await getAccountEntry(ACCOUNT, 'e1');
    expect(cached?.entry).toBeNull();
    expect(cached?.revision).toBe(2);
    expect(titlesOf(await displayedLibrary(ACCOUNT))).toEqual([]);

    // A stale signed-out copy of the same id is suppressed by the account tombstone.
    expect(mergeLibraryEntries([entryOf('e1', 'stale local copy')], await listAccountEntries(ACCOUNT), ACCOUNT)).toEqual([]);
  });
});

describe('two-device sync > concurrent divergence', () => {
  it('records a conflict when A and B edit the same entry offline, losing neither version', async () => {
    const context = convergenceContext();
    const { server, deviceA, deviceB, accountId } = context;

    activateDevice(deviceA);
    await queueAccountSave(accountId, entryOf('e1', 'Created on A'), 0);
    await syncDevice(server, accountId);

    activateDevice(deviceB);
    await syncDevice(server, accountId);

    // Both devices edit the same base revision while the server is unreachable.
    server.fault('list_account_entries', 'offline');
    server.fault('apply_entry_change', 'offline');
    activateDevice(deviceA);
    await editEntry(accountId, 'e1', 'Edited on A');
    activateDevice(deviceB);
    await editEntry(accountId, 'e1', 'Edited on B');
    server.fault('list_account_entries', null);
    server.fault('apply_entry_change', null);

    // A syncs first and wins the server revision.
    activateDevice(deviceA);
    const aSync = await syncDevice(server, accountId);
    expect(aSync.pushed).toBe(1);
    expect(aSync.conflictsDetected).toBe(0);
    expect(server.row(accountId, 'e1')).toMatchObject({ revision: 2, deleted: false, payload: { title: 'Edited on A' } });

    // B's pull now diverges from its queued base: it must conflict, not overwrite.
    activateDevice(deviceB);
    const bSync = await syncDevice(server, accountId);
    expect(bSync.pushed).toBe(0);
    expect(bSync.conflictsDetected).toBe(1);

    // A's version stays on the server...
    expect(server.row(accountId, 'e1')).toMatchObject({ revision: 2, deleted: false, payload: { title: 'Edited on A' } });

    // ...and B's version is still recoverable: queued in the outbox and recorded
    // on the conflict, never silently dropped.
    const pending = await listPending(accountId);
    expect(pending).toHaveLength(1);
    expect(pending[0].entry?.title).toBe('Edited on B');
    const conflicts = await listConflicts(accountId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].entryId).toBe('e1');
    expect(conflicts[0].local?.entry?.title).toBe('Edited on B');
    expect(conflicts[0].server.entry?.title).toBe('Edited on A');
    expect(conflicts[0].server.revision).toBe(2);

    // B still displays its own edit while the conflict awaits a decision.
    expect(titlesOf(await displayedLibrary(accountId))).toContain('Edited on B');
  });

  it('keep-both leaves the server version on the original id and adds the local version as a new entry', async () => {
    const context = convergenceContext();
    const { server, deviceA, accountId } = context;
    await seedDivergedConflict(context);

    activateDevice(context.deviceB);
    const [conflict] = await listConflicts(accountId);
    expect(conflict).toBeDefined();
    await resolveConflictKeepBoth(accountId, conflict);

    // The original id now holds the server version and has nothing queued for it.
    expect((await getAccountEntry(accountId, 'e1'))?.entry?.title).toBe('Edited on A');
    expect(await listConflicts(accountId)).toEqual([]);
    const pendingAfterResolve = await listPending(accountId);
    expect(pendingAfterResolve.some((operation) => operation.entryId === 'e1')).toBe(false);
    expect(pendingAfterResolve).toHaveLength(1);
    const copyOperation = pendingAfterResolve[0];
    expect(copyOperation.expectedRevision).toBe(0);
    expect(copyOperation.entry?.title).toBe('Edited on B (conflict copy)');
    const copyId = copyOperation.entryId;
    expect(copyId).not.toBe('e1');

    // The queued copy reaches the server as a NEW entry; the original is untouched.
    const copySync = await syncDevice(server, accountId);
    expect(copySync.pushed).toBe(1);
    expect(copySync.conflictsDetected).toBe(0);
    expect(server.row(accountId, 'e1')).toMatchObject({ revision: 2, deleted: false, payload: { title: 'Edited on A' } });
    expect(server.row(accountId, copyId)).toMatchObject({ revision: 1, deleted: false, payload: { title: 'Edited on B (conflict copy)' } });

    const displayed = await displayedLibrary(accountId);
    expect(displayed).toHaveLength(2);
    expect(titlesOf(displayed)).toEqual(expect.arrayContaining(['Edited on A', 'Edited on B (conflict copy)']));

    // The other device converges on both entries as well.
    activateDevice(deviceA);
    await syncDevice(server, accountId);
    expect(titlesOf(await displayedLibrary(accountId))).toEqual(expect.arrayContaining(['Edited on A', 'Edited on B (conflict copy)']));
  });
});

describe('two-device sync > retryable failures', () => {
  it('a transient 5xx keeps the change queued with a retry count until a later sync succeeds', async () => {
    const server = new FakeSyncServer();
    const deviceA = newDeviceFactory();

    activateDevice(deviceA);
    await queueAccountSave(ACCOUNT, entryOf('e1', 'Queued through a 5xx'), 0);

    // The pull succeeds; only the write path is failing, as a real 5xx would.
    server.fault('apply_entry_change', 'server');
    const failed = await syncDevice(server, ACCOUNT);
    expect(failed.pushed).toBe(0);
    expect(failed.retries).toBe(1);
    expect(failed.errorKind).toBe('server');
    expect(failed.paused).toBe(false);
    const pendingAfterFailure = await listPending(ACCOUNT);
    expect(pendingAfterFailure).toHaveLength(1);
    expect(pendingAfterFailure[0].retryCount).toBe(1);
    expect(pendingAfterFailure[0].entry?.title).toBe('Queued through a 5xx');
    expect(server.row(ACCOUNT, 'e1')).toBeUndefined();
    // The unacknowledged change is still what this device displays.
    expect(titlesOf(await displayedLibrary(ACCOUNT))).toContain('Queued through a 5xx');

    // A second failed attempt increments the count again and still drops nothing.
    const failedAgain = await syncDevice(server, ACCOUNT);
    expect(failedAgain.retries).toBe(1);
    expect((await listPending(ACCOUNT))[0].retryCount).toBe(2);

    // Once the server recovers the same queued change applies exactly once.
    server.fault('apply_entry_change', null);
    const succeeded = await syncDevice(server, ACCOUNT);
    expect(succeeded.pushed).toBe(1);
    expect(succeeded.retries).toBe(0);
    expect(await listPending(ACCOUNT)).toEqual([]);
    expect(server.row(ACCOUNT, 'e1')).toMatchObject({ revision: 1, deleted: false, payload: { title: 'Queued through a 5xx' } });
  });

  it('treats a simulated 401 as a permanent failure without writing or dropping the change', async () => {
    const server = new FakeSyncServer();
    const deviceA = newDeviceFactory();

    activateDevice(deviceA);
    await queueAccountSave(ACCOUNT, entryOf('e1', 'Sent with an expired session'), 0);

    server.fault('apply_entry_change', 'auth');
    const report = await syncDevice(server, ACCOUNT);
    expect(report.pushed).toBe(0);
    expect(report.errorKind).toBe('unauthenticated');
    expect(server.row(ACCOUNT, 'e1')).toBeUndefined();

    const pending = await listPending(ACCOUNT);
    expect(pending).toHaveLength(1);
    expect(pending[0].retryCount).toBe(1);
    expect(pending[0].lastError).not.toBeNull();
    expect(pending[0].entry?.title).toBe('Sent with an expired session');
  });
});

describe('two-device sync > account isolation', () => {
  it('syncing one account on a device never writes into another account cache there', async () => {
    const server = new FakeSyncServer();
    const device = newDeviceFactory();
    const ALICE = 'alice-account';
    const BOB = 'bob-account';

    activateDevice(device);
    await queueAccountSave(ALICE, entryOf('a1', 'Alice only'), 0);
    await queueAccountSave(BOB, entryOf('b1', 'Bob only'), 0);

    const report = await syncDevice(server, BOB);
    expect(report.pushed).toBe(1);

    // The server keeps Bob's write under Bob's account and Alice's untouched.
    expect(server.rowsFor(ALICE)).toEqual([]);
    expect(server.row(BOB, 'b1')).toMatchObject({ revision: 1, deleted: false, payload: { title: 'Bob only' } });

    // Alice's cache and outbox are exactly what they were: nothing from Bob's
    // pull or push landed in them.
    const aliceCache = await listAccountEntries(ALICE);
    expect(aliceCache.map((record) => record.entryId)).toEqual(['a1']);
    expect(aliceCache[0].entry?.title).toBe('Alice only');
    expect(aliceCache[0].revision).toBe(0);
    expect((await listPending(ALICE)).map((operation) => operation.entryId)).toEqual(['a1']);
    expect(await listPending(BOB)).toEqual([]);
    expect(await listAccountEntries(BOB)).toHaveLength(1);

    // Each account's gallery only shows its own entry.
    expect(titlesOf(await displayedLibrary(ALICE))).toEqual(['Alice only']);
    expect(titlesOf(await displayedLibrary(BOB))).toEqual(['Bob only']);
  });
});
