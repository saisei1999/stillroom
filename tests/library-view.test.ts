import { describe, it, expect } from 'vitest';
import { mergeLibraryEntries } from '../src/library-view';
import type { AccountRecord, Entry } from '../src/storage';

const entry = (id: string, createdAt: string, over: Partial<Entry> = {}): Entry => ({
  id,
  title: id,
  type: 'Book',
  status: 'Planned',
  color: 'blue',
  progress: '',
  tags: ['t'],
  notes: '',
  createdAt,
  ...over,
});

const record = (accountId: string, entryId: string, cached: Entry | null, over: Partial<AccountRecord> = {}): AccountRecord => ({
  accountId,
  entryId,
  entry: cached,
  revision: 0,
  ...over,
});

const ACCOUNT = 'account-1';

describe('library view > mergeLibraryEntries', () => {
  it('returns local entries unchanged when there is no active account', () => {
    const local = [entry('a', '2026-01-01T00:00:00.000Z'), entry('b', '2026-02-01T00:00:00.000Z')];
    const cached = [record(ACCOUNT, 'c', entry('c', '2026-03-01T00:00:00.000Z'))];
    const merged = mergeLibraryEntries(local, cached, null);
    expect(merged).toBe(local);
    expect(merged.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('adds account-cached entries alongside local entries when signed in', () => {
    const local = [entry('local-only', '2026-01-01T00:00:00.000Z')];
    const cached = [record(ACCOUNT, 'pulled', entry('pulled', '2026-02-01T00:00:00.000Z'))];
    const merged = mergeLibraryEntries(local, cached, ACCOUNT);
    expect(merged.map((e) => e.id).sort()).toEqual(['local-only', 'pulled']);
  });

  it('excludes deletion tombstones from the account cache', () => {
    const cached = [record(ACCOUNT, 'deleted', null, { revision: 3 })];
    const merged = mergeLibraryEntries([], cached, ACCOUNT);
    expect(merged).toEqual([]);
  });

  it('a tombstone suppresses a stale local copy of the same entry', () => {
    const local = [entry('gone', '2026-01-01T00:00:00.000Z'), entry('kept', '2026-01-02T00:00:00.000Z')];
    const cached = [record(ACCOUNT, 'gone', null, { revision: 4 })];
    const merged = mergeLibraryEntries(local, cached, ACCOUNT);
    expect(merged.map((e) => e.id)).toEqual(['kept']);
  });

  it('deduplicates by id and prefers the account record', () => {
    const local = entry('same', '2026-01-01T00:00:00.000Z', { title: 'local title', notes: 'local notes' });
    const cached = record(ACCOUNT, 'same', entry('same', '2026-01-01T00:00:00.000Z', { title: 'account title', notes: 'account notes' }), { revision: 7 });
    const merged = mergeLibraryEntries([local], [cached], ACCOUNT);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('account title');
    expect(merged[0].notes).toBe('account notes');
  });

  it('ignores records belonging to a different account', () => {
    const local = [entry('local', '2026-01-01T00:00:00.000Z')];
    const cached = [
      record('other-account', 'leaked', entry('leaked', '2026-03-01T00:00:00.000Z')),
      record(ACCOUNT, 'mine', entry('mine', '2026-02-01T00:00:00.000Z')),
    ];
    const merged = mergeLibraryEntries(local, cached, ACCOUNT);
    expect(merged.map((e) => e.id)).toEqual(['mine', 'local']);
  });

  it('sorts the merged list by createdAt descending', () => {
    const local = [entry('middle', '2026-02-01T00:00:00.000Z'), entry('oldest', '2026-01-01T00:00:00.000Z')];
    const cached = [record(ACCOUNT, 'newest', entry('newest', '2026-03-01T00:00:00.000Z'))];
    const merged = mergeLibraryEntries(local, cached, ACCOUNT);
    expect(merged.map((e) => e.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('does not mutate its inputs', () => {
    const local = [entry('a', '2026-01-01T00:00:00.000Z')];
    const cached = [record(ACCOUNT, 'b', entry('b', '2026-03-01T00:00:00.000Z')), record(ACCOUNT, 'c', null)];
    const localSnapshot = JSON.parse(JSON.stringify(local));
    const cachedSnapshot = JSON.parse(JSON.stringify(cached));
    const merged = mergeLibraryEntries(local, cached, ACCOUNT);
    expect(merged).not.toBe(local);
    expect(local).toEqual(localSnapshot);
    expect(cached).toEqual(cachedSnapshot);
    expect(local).toHaveLength(1);
    expect(cached).toHaveLength(2);
  });

  it('handles empty inputs', () => {
    expect(mergeLibraryEntries([], [], ACCOUNT)).toEqual([]);
    expect(mergeLibraryEntries([], [], null)).toEqual([]);
  });
});
