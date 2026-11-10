import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { acknowledgeChange, discardChange, closeDatabase, queueAccountChange, listPending, listConflicts, storeConflict, getAccountEntry, type AccountRecord, type OutboxRecord, type Entry } from '../src/storage';
import { summarizeSync, conflictPreview, routeLocalMutation, setActiveAccount, queueAccountSave, queueAccountDelete, resolveConflictKeepBoth, resolveConflictUseTheirs, isWaiting, runSync, SYNC_ENABLED, type ImportChoice } from '../src/sync-control';
import type { SyncReport } from '../src/account-sync';

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

const record = (accountId: string, entryId: string, over: Partial<AccountRecord> = {}): AccountRecord => ({
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

describe('sync control > summary', () => {
  it('is honest and never over-claims', () => {
    expect(summarizeSync({ pushed: 0, pulled: 0, conflictsDetected: 0, waiting: 0, retries: 0, lastError: null, errorKind: null, paused: false }, [], [])).toContain('Synced');
    expect(summarizeSync({ pushed: 0, pulled: 0, conflictsDetected: 0, waiting: 2, retries: 0, lastError: null, errorKind: null, paused: false }, [{}, {}] as never, [])).toContain('changes waiting');
    expect(summarizeSync({ pushed: 0, pulled: 0, conflictsDetected: 0, waiting: 0, retries: 0, lastError: null, errorKind: null, paused: false }, [], [{}] as never)).toContain('conflict');
  });

  it('detects a waiting (retrying or paused) state', () => {
    const retrying: SyncReport = { pushed: 0, pulled: 0, conflictsDetected: 0, waiting: 0, retries: 2, lastError: 'x', errorKind: 'offline', paused: false };
    const clean: SyncReport = { pushed: 0, pulled: 0, conflictsDetected: 0, waiting: 0, retries: 0, lastError: null, errorKind: null, paused: false };
    expect(isWaiting(retrying)).toBe(true);
    expect(isWaiting(clean)).toBe(false);
  });
});

describe('sync control > conflict preview', () => {
  it('describes the two sides without mutating the record', () => {
    const conf = {
      accountId: 'acct',
      entryId: 'a',
      local: change('acct', 'a', { expectedRevision: 3 }),
      server: record('acct', 'a', { entry: entryOf('a', 'server'), revision: 6 }),
      detectedAt: '2026-01-01T00:00:00.000Z',
    };
    const view = conflictPreview(conf);
    expect(view.kind).toBe('diverged');
    expect(view.localPreview).toContain('edited here');
    expect(conf.local?.entry?.title).toBe('a'); // unchanged
  });
});

describe('sync control > mutation routing', () => {
  it('returns false (local-only) when sync is disabled or no account is active', async () => {
    setActiveAccount(null);
    // SYNC_ENABLED is false in this build, so routing is always the local path.
    expect(await routeLocalMutation('a', 'save', entryOf('a'))).toBe(false);
    setActiveAccount('acct');
    expect(await routeLocalMutation('a', 'save', entryOf('a'))).toBe(false);
    setActiveAccount(null);
  });

  it('keeps a newer save when the previous save is acknowledged', async () => {
    await queueAccountSave('acct', entryOf('a', 'first'), 2);
    const [first] = await listPending('acct');
    await queueAccountSave('acct', entryOf('a', 'second'), 2);
    const [newer] = await listPending('acct');
    expect(newer.operationId).not.toBe(first.operationId);
    expect(await acknowledgeChange('acct', 'a', first.operationId, 3)).toBe('superseded');
    expect(await listPending('acct')).toMatchObject([{ operationId: newer.operationId, expectedRevision: 3, entry: { title: 'second' } }]);
  });

  it('keeps a newer delete when the previous save is acknowledged or discarded', async () => {
    await queueAccountSave('acct', entryOf('a'), 2);
    const [first] = await listPending('acct');
    await queueAccountDelete('acct', 'a');
    const [newer] = await listPending('acct');
    expect(newer.operationId).not.toBe(first.operationId);
    expect(await discardChange('acct', 'a', first.operationId)).toBe(false);
    expect(await acknowledgeChange('acct', 'a', first.operationId, 3)).toBe('superseded');
    expect(await listPending('acct')).toMatchObject([{ operationId: newer.operationId, expectedRevision: 3, entry: null }]);
  });

  it('keeps BOTH sides: local copy as a new entry, server version on the original id', async () => {
    const local = change('acct', 'a', { expectedRevision: 2, entry: entryOf('a', 'my local edit') });
    const server = record('acct', 'a', { revision: 3, entry: entryOf('a', 'the server version') });
    const conflict = { accountId: 'acct', entryId: 'a', local, server, detectedAt: '2026-01-01T00:00:00.000Z' };
    await queueAccountChange(record('acct', 'a', { revision: 2, entry: local.entry }), local);
    await storeConflict(conflict);

    await resolveConflictKeepBoth('acct', conflict);

    const pending = await listPending('acct');
    // The original id keeps the SERVER version and has nothing queued for it, so
    // the local edit can never be pushed over the server copy.
    expect(pending.some((op) => op.entryId === 'a')).toBe(false);
    const original = await getAccountEntry('acct', 'a');
    expect(original?.entry?.title).toBe('the server version');
    expect(original?.revision).toBe(3);
    // The local version survives as a brand-new entry queued as a create.
    const copyOp = pending.find((op) => op.entryId !== 'a');
    expect(copyOp).toBeDefined();
    expect(copyOp?.expectedRevision).toBe(0);
    expect(copyOp?.entry?.title).toContain('conflict copy');
    expect(copyOp?.entry?.title).toContain('my local edit');
    // The conflict is resolved, not left dangling.
    expect(await listConflicts('acct')).toEqual([]);
  });

  it('never overwrites the server copy when keeping both', async () => {
    const local = change('acct', 'a', { expectedRevision: 2, entry: entryOf('a', 'my local edit') });
    const server = record('acct', 'a', { revision: 3, entry: entryOf('a', 'the server version') });
    const conflict = { accountId: 'acct', entryId: 'a', local, server, detectedAt: '2026-01-01T00:00:00.000Z' };
    await queueAccountChange(record('acct', 'a', { revision: 2, entry: local.entry }), local);
    await resolveConflictKeepBoth('acct', conflict);
    // A fresh operation id from the old (pre-fix) rebase must not be acknowledged
    // as if it were still queued for the original id.
    expect(await acknowledgeChange('acct', 'a', local.operationId, 3)).toBe('unknown-operation');
  });

  it('"use theirs" adopts the server row, drops the local edit and clears the conflict', async () => {
    const local = change('acct', 'a', { expectedRevision: 2, entry: entryOf('a', 'my local edit') });
    const server = record('acct', 'a', { revision: 5, entry: entryOf('a', 'the server version') });
    const conflict = { accountId: 'acct', entryId: 'a', local, server, detectedAt: '2026-01-01T00:00:00.000Z' };
    await queueAccountChange(record('acct', 'a', { revision: 2, entry: local.entry }), local);
    await storeConflict(conflict);

    await resolveConflictUseTheirs('acct', conflict);

    const cached = await getAccountEntry('acct', 'a');
    expect(cached?.entry?.title).toBe('the server version');
    expect(cached?.revision).toBe(5);
    expect(await listPending('acct')).toEqual([]);
    expect(await listConflicts('acct')).toEqual([]);
  });

  it('"use theirs" accepts a server deletion as a tombstone', async () => {
    const local = change('acct', 'a', { expectedRevision: 2, entry: entryOf('a', 'my local edit') });
    const server = record('acct', 'a', { revision: 4, entry: null });
    const conflict = { accountId: 'acct', entryId: 'a', local, server, detectedAt: '2026-01-01T00:00:00.000Z' };
    await queueAccountChange(record('acct', 'a', { revision: 2, entry: local.entry }), local);
    await storeConflict(conflict);

    await resolveConflictUseTheirs('acct', conflict);

    expect((await getAccountEntry('acct', 'a'))?.entry).toBeNull();
    expect(await listPending('acct')).toEqual([]);
    expect(await listConflicts('acct')).toEqual([]);
  });

  it('queues a durable delete tombstone for an account-owned entry', async () => {
    await queueAccountChange(record('acct', 'a', { revision: 2 }), change('acct', 'a', { expectedRevision: 2 }));
    await queueAccountDelete('acct', 'a');
    const pending = await listPending('acct');
    expect(pending[0].entry).toBeNull();
    expect(pending[0].expectedRevision).toBe(2);
    // Account cache now reflects the tombstone expectation.
    expect((await getAccountEntry('acct', 'a'))?.entry).toBeNull();
  });
});

describe('sync control > disabled build', () => {
  it('keeps sync disabled and resolves a no-op report without touching the network', async () => {
    expect(SYNC_ENABLED).toBe(false);
    const report = await runSync('acct');
    expect(report).toMatchObject({ pushed: 0, pulled: 0, conflictsDetected: 0, waiting: 0, retries: 0, lastError: null, errorKind: null, paused: false });
  });
});

describe('sync control > import choice type', () => {
  it('import choice defaults to nothing staged', () => {
    const choice: ImportChoice = null;
    expect(choice).toBeNull();
  });
});