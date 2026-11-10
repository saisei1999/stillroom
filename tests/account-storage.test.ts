import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  closeDatabase,
  listEntries,
  putEntry,
  deleteEntry,
  listAccountEntries,
  getAccountEntry,
  listPending,
  queueAccountChange,
  replaceQueuedChange,
  applyServerRow,
  cacheServerRows,
  getPending,
  acknowledgeChange,
  discardChange,
  recordFailure,
  storeConflict,
  clearConflict,
  listConflicts,
  stageLocalImport,
  revertStagedImport,
  clearAccountCache,
  markAccountCached,
  listCachedAccounts,
  type AccountRecord,
  type OutboxRecord,
  type Entry,
} from '../src/storage';

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

describe('account sync storage > two-account isolation', () => {
  it('keeps entries of separate accounts strictly apart', async () => {
    await putEntry(entryOf('local'));
    await stageLocalImport('acctA');
    await putEntry(entryOf('localB'));
    await stageLocalImport('acctB');

    const local = await listEntries();
    expect(local.map((e) => e.id)).toEqual(['local', 'localB']);

    const a = await listAccountEntries('acctA');
    const b = await listAccountEntries('acctB');
    expect(a.map((r) => r.entryId)).toEqual(['local']);
    expect(b.map((r) => r.entryId)).toEqual(['local', 'localB']);
    for (const row of a) expect(row.accountId).toBe('acctA');
    for (const row of b) expect(row.accountId).toBe('acctB');
  });

  it('queues a local change atomically with its cached view', async () => {
    const record = accountRecord('alice', 'e1', { revision: 0 });
    const op = change('alice', 'e1');
    await queueAccountChange(record, op);
    expect(await getAccountEntry('alice', 'e1')).toEqual(record);
    expect(await getPending('alice', 'e1')).toEqual(op);
    // Another account must never observe them.
    expect(await getAccountEntry('bob', 'e1')).toBeUndefined();
    expect(await getPending('bob', 'e1')).toBeUndefined();
  });

  it('rejects a change whose account or payload does not match its cached view', async () => {
    expect(() => queueAccountChange(accountRecord('alice', 'e1'), change('bob', 'e1'))).toThrow();
    expect(() => queueAccountChange(accountRecord('alice', 'e1'), change('alice', 'e2'))).toThrow();
    const mismatchedEntry = change('alice', 'e1');
    mismatchedEntry.entry = entryOf('e1', 'different title');
    expect(() => queueAccountChange(accountRecord('alice', 'e1'), mismatchedEntry)).toThrow();
  });
});

describe('account sync storage > acknowledgement', () => {
  it('marks the change as applied when it is still the head of the outbox', async () => {
    const record = accountRecord('alice', 'e1', { revision: 0 });
    await queueAccountChange(record, change('alice', 'e1', { expectedRevision: 0 }));
    expect(await acknowledgeChange('alice', 'e1', 'op-e1', 7)).toBe('applied');
    expect(await getPending('alice', 'e1')).toBeUndefined();
    expect((await getAccountEntry('alice', 'e1'))?.revision).toBe(7);
    // Acknowledging again with nothing queued is unknown work.
    expect(await acknowledgeChange('alice', 'e1', 'op-e1', 7)).toBe('unknown-operation');
  });

  it('keeps a newer concurrent edit queued and rebases its expectation', async () => {
    await queueAccountChange(accountRecord('alice', 'e1', { revision: 0 }), change('alice', 'e1', { expectedRevision: 0 }));
    // A newer offline edit arrives while the first request is in flight.
    await replaceQueuedChange(accountRecord('alice', 'e1', { revision: 0 }), change('alice', 'e1', { expectedRevision: 7, operationId: 'op-e1-new' }));
    expect(await acknowledgeChange('alice', 'e1', 'op-e1', 7)).toBe('superseded');
    const pending = await getPending('alice', 'e1');
    expect(pending?.operationId).toBe('op-e1-new');
    expect(pending?.expectedRevision).toBe(7);
  });

  it('reports an unknown operation when nothing is queued for that entry', async () => {
    expect(await acknowledgeChange('alice', 'e1', 'op-1', 3)).toBe('unknown-operation');
  });

  it('rebases a pending change whose expectation is behind a pulled server row', async () => {
    await queueAccountChange(accountRecord('alice', 'e1'), change('alice', 'e1', { expectedRevision: 0, operationId: 'op-1' }));
    await applyServerRow('alice', accountRecord('alice', 'e1', { entry: entryOf('e1', 'server v1'), revision: 5 }));
    const pending = await getPending('alice', 'e1');
    expect(pending?.expectedRevision).toBe(5);
    expect(pending?.retryCount).toBe(0);
    expect((await getAccountEntry('alice', 'e1'))?.revision).toBe(5);
  });

  it('re-applies a failure patch only to the owning operation', async () => {
    await queueAccountChange(accountRecord('alice', 'e1'), change('alice', 'e1', { expectedRevision: 0, operationId: 'op-1' }));
    await recordFailure('alice', 'e1', 'op-1', { retryCount: 1, nextAttemptAt: '2026-02-01T00:00:00.000Z', lastError: 'boom' });
    const pending = await getPending('alice', 'e1');
    expect(pending?.retryCount).toBe(1);
    expect(pending?.lastError).toBe('boom');
    // A stale operation id must not corrupt the record.
    await recordFailure('alice', 'e1', 'op-stale', { retryCount: 9, nextAttemptAt: 'x', lastError: 'stale' });
    expect((await getPending('alice', 'e1'))?.retryCount).toBe(1);
  });

  it('only discards a change owned by the given operation id', async () => {
    await queueAccountChange(accountRecord('alice', 'e1'), change('alice', 'e1', { expectedRevision: 0, operationId: 'op-1' }));
    expect(await discardChange('alice', 'e1', 'op-wrong')).toBe(false);
    expect(await getPending('alice', 'e1')).toBeDefined();
    expect(await discardChange('alice', 'e1', 'op-1')).toBe(true);
    expect(await getPending('alice', 'e1')).toBeUndefined();
  });
});

describe('account sync storage > conflicts', () => {
  it('stores, lists and clears a conflict scoped to its account', async () => {
    await queueAccountChange(accountRecord('alice', 'e1'), change('alice', 'e1', { expectedRevision: 0, operationId: 'op-1' }));
    await storeConflict({
      accountId: 'alice',
      entryId: 'e1',
      local: (await getPending('alice', 'e1')) ?? null,
      server: accountRecord('alice', 'e1', { entry: entryOf('e1', 'server'), revision: 4 }),
      detectedAt: '2026-01-02T00:00:00.000Z',
    });
    expect((await listConflicts('alice')).map((c) => c.entryId)).toEqual(['e1']);
    expect(await listConflicts('bob')).toEqual([]);
    await clearConflict('alice', 'e1');
    expect(await listConflicts('alice')).toEqual([]);
  });
});

describe('account sync storage > import', () => {
  it('copies the local library into an account without touching the local store', async () => {
    await putEntry(entryOf('a'));
    await putEntry(entryOf('b'));
    const result = await stageLocalImport('alice');
    expect(result.staged).toBe(2);
    expect(result.skipped).toBe(0);
    // Local library unchanged.
    expect((await listEntries()).map((e) => e.id)).toEqual(['a', 'b']);
    expect((await listAccountEntries('alice')).map((r) => r.entryId)).toEqual(['a', 'b']);
    expect((await listPending('alice')).every((p) => p.expectedRevision === 0)).toBe(true);
  });

  it('skips entries the account already knows when staged again', async () => {
    await putEntry(entryOf('a'));
    await stageLocalImport('alice');
    const second = await stageLocalImport('alice');
    expect(second.staged).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('reverts only staged entries that never reached the server', async () => {
    await putEntry(entryOf('a'));
    await putEntry(entryOf('b'));
    await stageLocalImport('alice');
    // Simulate 'a' reaching the server (acknowledged, retry cleared, revision advanced).
    await acknowledgeChange('alice', 'a', (await getPending('alice', 'a'))!.operationId, 1);
    const removed = await revertStagedImport('alice', ['a', 'b']);
    expect(removed).toBe(1);
    expect(await getAccountEntry('alice', 'a')).toBeDefined();
    expect(await getAccountEntry('alice', 'b')).toBeUndefined();
    expect(await getPending('alice', 'b')).toBeUndefined();
  });
});

describe('account sync storage > pull never clobbers pending edits', () => {
  it('keeps the pending local version and records a conflict when a pull brings a different server row', async () => {
    const local = accountRecord('alice', 'e1', { revision: 0, entry: entryOf('e1', 'local edit') });
    await queueAccountChange(local, change('alice', 'e1', { expectedRevision: 0, operationId: 'op-local', entry: entryOf('e1', 'local edit') }));
    const pulled = accountRecord('alice', 'e1', { revision: 5, entry: entryOf('e1', 'server v5') });

    const result = await cacheServerRows('alice', [pulled]);

    expect(result.conflicted).toEqual(['e1']);
    // The unacknowledged local version survives; the server row is not written over it.
    expect(await getAccountEntry('alice', 'e1')).toEqual(local);
    expect((await getPending('alice', 'e1'))?.operationId).toBe('op-local');
    // The divergence is recorded for review instead of being silently discarded.
    const [conflict] = await listConflicts('alice');
    expect(conflict.entryId).toBe('e1');
    expect(conflict.local?.operationId).toBe('op-local');
    expect(conflict.local?.entry?.title).toBe('local edit');
    expect(conflict.server).toEqual(pulled);
  });

  it('adopts a pulled row when nothing is pending for it', async () => {
    const pulled = accountRecord('alice', 'e2', { revision: 2, entry: entryOf('e2', 'server') });

    const result = await cacheServerRows('alice', [pulled]);

    expect(result).toEqual({ cached: 1, conflicted: [] });
    expect(await getAccountEntry('alice', 'e2')).toEqual(pulled);
    expect(await listConflicts('alice')).toEqual([]);
  });

  it('keeps the pending local version without a conflict when the pull matches its base revision', async () => {
    const local = accountRecord('alice', 'e3', { revision: 2, entry: entryOf('e3', 'local edit') });
    await queueAccountChange(local, change('alice', 'e3', { expectedRevision: 2, operationId: 'op-3', entry: entryOf('e3', 'local edit') }));
    const pulled = accountRecord('alice', 'e3', { revision: 2, entry: entryOf('e3', 'server base') });

    const result = await cacheServerRows('alice', [pulled]);

    expect(result.conflicted).toEqual([]);
    // Still never overwritten: the queued local version is what will be pushed.
    expect(await getAccountEntry('alice', 'e3')).toEqual(local);
    expect(await getPending('alice', 'e3')).toBeDefined();
    expect(await listConflicts('alice')).toEqual([]);
  });
});

describe('account sync storage > cache teardown', () => {
  it('clears one account without touching local or other accounts', async () => {
    await putEntry(entryOf('local1'));
    await putEntry(entryOf('local2'));
    await putEntry(entryOf('local3'));
    await stageLocalImport('alice');
    await putEntry(entryOf('onlyB'));
    await stageLocalImport('bob');

    await clearAccountCache('alice');
    expect(await listAccountEntries('alice')).toEqual([]);
    expect((await listAccountEntries('bob')).some((r) => r.entryId === 'onlyB')).toBe(true);
    expect((await listEntries()).map((e) => e.id).sort()).toEqual(['local1', 'local2', 'local3', 'onlyB']);
  });

  it('records which accounts have caches so work can resume after a reload', async () => {
    await markAccountCached('alice');
    await markAccountCached('bob');
    expect((await listCachedAccounts()).sort()).toEqual(['alice', 'bob']);
    await clearAccountCache('alice');
    expect(await listCachedAccounts()).toEqual(['bob']);
  });
});