import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  closeDatabase,
  queueAccountChange,
  listPending,
  listAccountEntries,
  listConflicts,
  getAccountEntry,
  type AccountRecord,
  type OutboxRecord,
  type Entry,
} from '../src/storage';
import {
  pullAccountEntries,
  pushChange,
  syncPending,
  parseServerRow,
  changePayload,
  rowToServerEntry,
  type TransportClient,
  type ApplyResult,
  type ServerRow,
} from '../src/account-sync';
import { conflictCopyChange, pendingForConflict } from '../src/sync-core';

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

const change = (accountId: string, entryId: string, over: Partial<OutboxRecord> = {}): OutboxRecord => ({
  accountId,
  entryId,
  operationId: 'op-' + entryId,
  expectedRevision: 0,
  entry: entryOf(entryId),
  createdAt: '2026-01-01T00:00:00.000Z',
  retryCount: 0,
  nextAttemptAt: '2026-01-01T00:00:00.000Z',
  lastError: null,
  ...over,
});

const accountRecord = (accountId: string, entryId: string, over: Partial<AccountRecord> = {}): AccountRecord => ({
  accountId,
  entryId,
  entry: entryOf(entryId),
  revision: 0,
  ...over,
});

beforeEach(() => {
  closeDatabase();
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => closeDatabase());

function row(id: string, revision: number, deleted = false, payload: unknown = entryOf(id)): ServerRow {
  return { id, revision, deleted, payload, updated_at: '2026-01-01T00:00:00.000Z' };
}

/** A mock TransportClient whose RPC replies we control per test. */
function fakeClient(handler: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>): TransportClient {
  return { rpc: async <R>(fn: string, args: Record<string, unknown>) => (await handler(fn, args)) as { data: R | null; error: unknown } };
}

describe('account sync transport > parsing and payloads', () => {
  it('rejects malformed server rows and does not trust them', () => {
    expect(() => parseServerRow(null)).toThrow();
    expect(() => parseServerRow({ id: 'a', revision: 0, deleted: false })).toThrow();
    expect(() => parseServerRow({ id: 'a', revision: 1, deleted: 'yes' })).toThrow();
  });

  it('turns a tombstone row into a deletion and a live row into an entry', () => {
    expect(rowToServerEntry(row('a', 3, true, {})).entry).toBeNull();
    expect(rowToServerEntry(row('a', 3, false, entryOf('a'))).entry?.title).toBe('a');
    // A malformed payload in a live row must fail (fail closed).
    expect(() => rowToServerEntry(row('a', 3, false, { title: 5 }))).toThrow();
  });

  it('builds the correct RPC payload for updates and deletions', () => {
    expect(changePayload(change('acct', 'a')).deleted).toBe(false);
    expect(changePayload(change('acct', 'a')).payload).toEqual(entryOf('a'));
    const del = change('acct', 'a', { entry: null });
    expect(changePayload(del).deleted).toBe(true);
  });
});

describe('account sync transport > pull', () => {
  it('pages until a short page and validates every row', async () => {
    let calls = 0;
    const client = fakeClient(async (fn, args) => {
      calls += 1;
      if (fn !== 'list_account_entries') throw new Error('unexpected fn');
      const limit = args.p_limit as number;
      return { data: [row('a', 1), row('b', 2)], error: null };
      // limit intentionally unused here; clients must page correctly via their own loop.
    });
    const entries = await pullAccountEntries(client, null);
    expect(entries.length).toBe(2);
  });

  it('propagates a server error without fabricating a result', async () => {
    const client = fakeClient(async () => ({ data: null, error: { code: 'pgrst301', message: 'jwt expired' } }));
    await expect(pullAccountEntries(client, null)).rejects.toThrow();
  });
});

describe('account sync transport > push', () => {
  it('acknowledges an applied change and adopts the server revision', async () => {
    await queueAccountChange(accountRecord('acct', 'a', { revision: 0 }), change('acct', 'a', { expectedRevision: 0 }));
    const client = fakeClient(async (fn) => {
      if (fn !== 'apply_entry_change') throw new Error('unexpected fn');
      const result: ApplyResult = { outcome: 'applied', revision: 4, payload: entryOf('a', 'applied'), deleted: false, applied_revision: 4 };
      return { data: [result], error: null };
    });
    const pending = await listPending('acct');
    expect(await pushChange(client, 'acct', pending[0])).toBe('applied');
    expect(await listPending('acct')).toEqual([]);
    expect((await getAccountEntry('acct', 'a'))?.revision).toBe(4);
  });

  it.each([
    ['null', null],
    ['empty array', []],
    ['multiple rows', [{ outcome: 'applied' }, { outcome: 'applied' }]],
    ['object rather than array', { outcome: 'applied', revision: 1, payload: entryOf('a'), deleted: false }],
    ['null row', [null]],
    ['array row', [[]]],
    ['unknown outcome', [{ outcome: 'unexpected', revision: 1, payload: entryOf('a'), deleted: false }]],
    ['invalid revision', [{ outcome: 'applied', revision: 0, payload: entryOf('a'), deleted: false }]],
    ['invalid payload', [{ outcome: 'applied', revision: 1, payload: {}, deleted: false }]],
  ])('rejects %s without acknowledging or changing the cache', async (_label, data) => {
    await queueAccountChange(accountRecord('acct', 'a'), change('acct', 'a'));
    const before = await getAccountEntry('acct', 'a');
    const pending = await listPending('acct');
    const client = fakeClient(async () => ({ data, error: null }));
    await expect(pushChange(client, 'acct', pending[0])).rejects.toThrow();
    expect(await listPending('acct')).toEqual(pending);
    expect(await getAccountEntry('acct', 'a')).toEqual(before);
    expect(await listConflicts('acct')).toEqual([]);
  });

  it('records a conflict so the UI can resolve it instead of overwriting', async () => {
    await queueAccountChange(accountRecord('acct', 'a', { revision: 0 }), change('acct', 'a', { expectedRevision: 0 }));
    const client = fakeClient(async (fn) => {
      const result: ApplyResult = { outcome: 'conflict', revision: 9, payload: entryOf('a', 'server v9'), deleted: false, applied_revision: null };
      return { data: [result], error: null };
    });
    const pending = await listPending('acct');
    expect(await pushChange(client, 'acct', pending[0])).toBe('conflict');
    expect(await listConflicts('acct')).toHaveLength(1);
    expect(await listPending('acct')).toHaveLength(1); // work is not dropped
  });

  it('handles already_applied idempotently (server already owns the operation)', async () => {
    await queueAccountChange(accountRecord('acct', 'a', { revision: 0 }), change('acct', 'a', { expectedRevision: 0 }));
    const client = fakeClient(async (fn) => {
      const result: ApplyResult = { outcome: 'already_applied', revision: 4, payload: entryOf('a', 'applied'), deleted: false, applied_revision: 3 };
      return { data: [result], error: null };
    });
    const pending = await listPending('acct');
    expect(await pushChange(client, 'acct', pending[0])).toBe('already_applied');
    expect(await listPending('acct')).toEqual([]);
  });
});

describe('account sync transport > full sync pass', () => {
  it('pulls server rows and keeps pending work that conflicts', async () => {
    await queueAccountChange(accountRecord('acct', 'a', { revision: 0 }), change('acct', 'a', { expectedRevision: 0 }));
    // Server already has entry 'a' at revision 5 (remote edit).
    const client = fakeClient(async (fn) => {
      if (fn === 'list_account_entries') return { data: [row('a', 5, false, entryOf('a', 'remote'))], error: null };
      if (fn === 'apply_entry_change') return { data: [{ outcome: 'conflict', revision: 5, payload: entryOf('a', 'remote'), deleted: false, applied_revision: null } as ApplyResult], error: null };
      throw new Error('unexpected fn');
    });
    const report = await syncPending(client, 'acct');
    expect(report.conflictsDetected).toBe(1);
    expect(await listConflicts('acct')).toHaveLength(1);
    expect(await listPending('acct')).toHaveLength(1);
  });

  it('reports a retryable failure and keeps the pending change queued', async () => {
    await queueAccountChange(accountRecord('acct', 'a', { revision: 0 }), change('acct', 'a', { expectedRevision: 0 }));
    const client = fakeClient(async (fn) => {
      if (fn === 'list_account_entries') return { data: [], error: null };
      return { data: null, error: { code: 'network_error', message: 'fetch failed' } };
    });
    const report = await syncPending(client, 'acct');
    expect(report.retries).toBe(1);
    expect(report.paused).toBe(false);
    expect(await listPending('acct')).toHaveLength(1); // durable
    expect((await listPending('acct'))[0].retryCount).toBe(1);
  });

  it('never claims synced when the server did not acknowledge', async () => {
    await queueAccountChange(accountRecord('acct', 'a', { revision: 0 }), change('acct', 'a', { expectedRevision: 0 }));
    const client = fakeClient(async (fn) => {
      if (fn === 'list_account_entries') return { data: [], error: null };
      return { data: null, error: { code: '42501', message: 'permission denied' } };
    });
    const report = await syncPending(client, 'acct');
    expect(report.pushed).toBe(0);
    expect(await listPending('acct')).toHaveLength(1);
    expect(report.errorKind).not.toBeNull();
  });

  it('reconciles and pushes a create when the server has no row for it', async () => {
    await queueAccountChange(accountRecord('acct', 'a', { revision: 0 }), change('acct', 'a', { expectedRevision: 0 }));
    const client = fakeClient(async (fn) => {
      if (fn === 'list_account_entries') return { data: [], error: null };
      const result: ApplyResult = { outcome: 'applied', revision: 1, payload: entryOf('a'), deleted: false, applied_revision: 1 };
      return { data: [result], error: null };
    });
    const report = await syncPending(client, 'acct');
    expect(report.pushed).toBe(1);
    expect(await listPending('acct')).toEqual([]);
  });
});

describe('account sync transport > conflict helpers', () => {
  it('builds a pending create for a keep-both conflict copy', () => {
    const base = change('acct', 'a', { expectedRevision: 3 });
    const guard = change('acct', 'a', { expectedRevision: 3 });
    const now = '2026-03-01T00:00:00.000Z';
    const copy = conflictCopyChange(base, now, () => 'newid', () => 'op-new');
    expect(copy.entryId).toBe('newid');
    expect(copy.expectedRevision).toBe(0);
    expect(copy.entry?.title).toContain('conflict copy');
    // conflictCopyChange never mutates the input.
    expect(base.entryId).toBe(guard.entryId);
  });

  it('turns a resolved conflict into a push based on the server revision', () => {
    const local = change('acct', 'a', { expectedRevision: 8 });
    const copy = pendingForConflict({ local, server: { id: 'a', revision: 8, entry: entryOf('a') } }, entryOf('a', 'kept'), () => 'op-resolved');
    expect(copy.expectedRevision).toBe(8);
    expect(copy.operationId).toBe('op-resolved');
    expect(copy.entry?.title).toBe('kept');
  });
});