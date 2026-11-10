import { describe, it, expect } from 'vitest';
import {
  MAX_AUTOMATIC_ATTEMPTS,
  MAX_PAYLOAD_BYTES,
  SyncValidationError,
  assertChangeForAccount,
  assertRecordForAccount,
  belongsToAccount,
  classifyConflict,
  conflictCopy,
  conflictCopyChange,
  createChangeFor,
  entryPayloadSize,
  exceededAutomaticAttempts,
  fitsPayloadLimit,
  friendlySyncError,
  isRetryable,
  nextRetryDelayMillis,
  parseEntry,
  parseServerEntry,
  pendingForConflict,
  planImport,
  reconcile,
  retryDelayCapMillis,
  RETRY_SCHEDULE_LENGTH,
  syncErrorKind,
  type Entry,
  type PendingChange,
  type ServerEntry,
} from '../src/sync-core';

const NOW = '2026-01-01T00:00:00.000Z';

const book: Entry = {
  id: 'one',
  title: 'Example',
  type: 'Book',
  status: 'Planned',
  color: 'blue',
  progress: '',
  tags: ['Favorite'],
  notes: 'Some notes',
  createdAt: NOW,
};

const rated: Entry = { ...book, id: 'rated', title: 'Rated', rating: 4 };

function pending(overrides: Partial<PendingChange> = {}): PendingChange {
  return { accountId: 'account-a', entryId: 'one', operationId: 'op-1', expectedRevision: 3, entry: book, createdAt: NOW, ...overrides };
}

function server(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return { id: 'one', revision: 3, entry: book, ...overrides };
}

function expectValidationFailure(run: () => unknown): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SyncValidationError);
  expect((error as SyncValidationError).name).toBe('SyncValidationError');
}

describe('reconcile', () => {
  it('accepts the server when there is no pending change', () => {
    const row = server({ revision: 9 });
    expect(reconcile(undefined, row)).toEqual({ kind: 'accept', server: row });
  });

  it('pushes when the expected revision matches the server', () => {
    const change = pending({ expectedRevision: 3 });
    expect(reconcile(change, server({ revision: 3 }))).toEqual({ kind: 'push', change });
  });

  it('pushes a creation queued with expectedRevision 0 when the server has no row (revision 0)', () => {
    const change = pending({ expectedRevision: 0, entry: { ...book, id: 'fresh' }, entryId: 'fresh' });
    expect(reconcile(change, { id: 'fresh', revision: 0, entry: null })).toEqual({ kind: 'push', change });
  });

  it('reports a conflict and preserves both sides when revisions differ', () => {
    const change = pending({ expectedRevision: 3, entry: { ...book, title: 'Local edit' } });
    const row = server({ revision: 4, entry: { ...book, title: 'Remote edit' } });
    const decision = reconcile(change, row);
    expect(decision.kind).toBe('conflict');
    if (decision.kind !== 'conflict') return;
    expect(decision.local).toBe(change);
    expect(decision.server).toBe(row);
    // never last-write-wins: neither side is mutated or chosen silently
    expect(decision.local.entry?.title).toBe('Local edit');
    expect(decision.server.entry?.title).toBe('Remote edit');
  });

  it('reports a conflict when the server is ahead or behind', () => {
    expect(reconcile(pending({ expectedRevision: 2 }), server({ revision: 3 })).kind).toBe('conflict');
    expect(reconcile(pending({ expectedRevision: 7 }), server({ revision: 3 })).kind).toBe('conflict');
  });

  it('refuses to compare a pending change with another entry', () => {
    expect(() => reconcile(pending(), server({ id: 'other' }))).toThrow();
    expect(() => reconcile(pending(), server({ id: '' }))).toThrow();
  });
});

describe('classifyConflict', () => {
  it('classifies a local change against a remote delete as deleted-remotely', () => {
    expect(classifyConflict(pending({ entry: book }), server({ revision: 4, entry: null }))).toBe('deleted-remotely');
  });

  it('classifies a local delete against a remote edit as deleted-locally', () => {
    expect(classifyConflict(pending({ entry: null }), server({ revision: 4, entry: { ...book, title: 'Remote' } }))).toBe('deleted-locally');
  });

  it('classifies two-sided edits as diverged', () => {
    expect(classifyConflict(pending({ entry: book }), server({ revision: 5, entry: rated }))).toBe('diverged');
  });

  it('classifies a local delete against a remote delete as deleted-remotely (delete wins)', () => {
    expect(classifyConflict(pending({ entry: null }), server({ revision: 5, entry: null }))).toBe('deleted-remotely');
  });
});

describe('parseServerEntry (untrusted network input)', () => {
  it('accepts a well-formed row and rebuilds it field by field', () => {
    const raw = { id: 'rated', revision: 2, entry: { ...rated, extra: 'dropped' } };
    const parsed = parseServerEntry(raw, 'rated');
    expect(parsed).toEqual({ id: 'rated', revision: 2, entry: rated });
    expect(Object.keys(parsed.entry ?? {})).not.toContain('extra');
    expect(parsed.entry).not.toBe(raw.entry);
  });

  it('accepts a tombstone row', () => {
    expect(parseServerEntry({ id: 'one', revision: 6, entry: null }, 'one')).toEqual({ id: 'one', revision: 6, entry: null });
  });

  it('accepts an entry without a rating but rejects an out-of-range rating', () => {
    expect(parseServerEntry({ id: 'one', revision: 1, entry: book }, 'one').entry?.rating).toBeUndefined();
    for (const rating of [0, 6, 4.5, -1, Number.NaN]) {
      expectValidationFailure(() => parseServerEntry({ id: 'rated', revision: 1, entry: { ...rated, rating } }, 'rated'));
    }
  });

  it('rejects a non-integer or out-of-range revision', () => {
    for (const revision of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '3', null, undefined]) {
      expectValidationFailure(() => parseServerEntry({ id: 'one', revision, entry: book }, 'one'));
    }
  });

  it('rejects a row whose id does not match, or whose entry id differs', () => {
    expectValidationFailure(() => parseServerEntry({ id: 'two', revision: 1, entry: book }, 'one'));
    expectValidationFailure(() => parseServerEntry({ id: 'one', revision: 1, entry: { ...book, id: 'two' } }, 'one'));
    expectValidationFailure(() => parseServerEntry({ id: 'one', revision: 1 }, ''));
  });

  it('rejects malformed entries', () => {
    const missingNotes = { id: book.id, title: book.title, type: book.type, status: book.status, color: book.color, progress: book.progress, tags: book.tags, createdAt: book.createdAt };
    const missingCreatedAt = { id: book.id, title: book.title, type: book.type, status: book.status, color: book.color, progress: book.progress, tags: book.tags, notes: book.notes };
    const cases: unknown[] = ['entry', [], 42, { ...book, title: '   ' }, { ...book, id: '' }, { ...book, tags: 'Favorite' }, { ...book, tags: ['ok', 3] }, missingNotes, missingCreatedAt, { ...book, status: 7 }];
    for (const entry of cases) expectValidationFailure(() => parseServerEntry({ id: 'one', revision: 1, entry }, 'one'));
  });

  it('rejects non-object rows, prototypes and missing entry keys', () => {
    for (const raw of [null, undefined, [], 'row', 42]) expectValidationFailure(() => parseServerEntry(raw, 'one'));
    expectValidationFailure(() => parseServerEntry({ id: 'one', revision: 1 }, 'one'));
    expectValidationFailure(() => parseServerEntry(Object.create({ id: 'one', revision: 1 }), 'one'));
  });

  it('parseEntry alone validates the same entry shape', () => {
    expect(parseEntry(book)).toEqual(book);
    expectValidationFailure(() => parseEntry({ ...book, rating: 9 }));
  });
});

describe('payload size', () => {
  it('counts UTF-8 bytes and enforces the server limit', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(262144);
    expect(entryPayloadSize(book)).toBe(new TextEncoder().encode(JSON.stringify(book)).length);
    // "é" is two UTF-8 bytes on the wire, so it must cost the same as "xx".
    expect(entryPayloadSize({ ...book, notes: String.fromCodePoint(0xe9) })).toBe(entryPayloadSize({ ...book, notes: 'xx' }));
    expect(entryPayloadSize({ ...book, notes: String.fromCodePoint(0x1f600) })).toBe(entryPayloadSize({ ...book, notes: 'xxxx' }));
    expect(fitsPayloadLimit(book)).toBe(true);
    const huge: Entry = { ...book, notes: 'x'.repeat(MAX_PAYLOAD_BYTES) };
    expect(entryPayloadSize(huge)).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    expect(fitsPayloadLimit(huge)).toBe(false);
    const empty: Entry = { ...book, notes: '' };
    const near: Entry = { ...book, notes: 'x'.repeat(MAX_PAYLOAD_BYTES - entryPayloadSize(empty)) };
    expect(entryPayloadSize(near)).toBe(MAX_PAYLOAD_BYTES);
    expect(fitsPayloadLimit(near)).toBe(true);
  });
});

describe('account guard', () => {
  it('matches only the change owner account', () => {
    const change = pending({ accountId: 'account-a' });
    expect(belongsToAccount(change, 'account-a')).toBe(true);
    expect(belongsToAccount(change, 'account-b')).toBe(false);
    expect(belongsToAccount(change, '')).toBe(false);
  });

  it('throws when a change is sent under another account', () => {
    const change = pending({ accountId: 'account-a' });
    expect(() => assertChangeForAccount(change, 'account-a')).not.toThrow();
    expect(() => assertChangeForAccount(change, 'account-b')).toThrow();
    expect(() => assertChangeForAccount(change, '')).toThrow();
  });

  it('throws when a cached record belongs to another account', () => {
    const record = { accountId: 'account-a', entryId: 'one', entry: book, revision: 3 };
    expect(() => assertRecordForAccount(record, 'account-a')).not.toThrow();
    expect(() => assertRecordForAccount(record, 'account-b')).toThrow();
  });
});

describe('retry scheduling', () => {
  it('grows exponentially and caps at five minutes', () => {
    expect([0, 1, 2, 3, 4, 5].map((attempt) => retryDelayCapMillis(attempt))).toEqual([2000, 4000, 8000, 16000, 32000, 64000]);
    expect(retryDelayCapMillis(RETRY_SCHEDULE_LENGTH - 1)).toBe(300000);
    expect(retryDelayCapMillis(20)).toBe(300000);
    expect(retryDelayCapMillis(-3)).toBe(2000);
    expect(retryDelayCapMillis(Number.NaN)).toBe(2000);
  });

  it('is monotonic when random is fixed', () => {
    const fixed = () => 0.5;
    const delays = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => nextRetryDelayMillis(attempt, fixed));
    for (let index = 1; index < delays.length; index++) expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1]);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 150000]);
  });

  it('keeps full jitter inside [0, capped delay]', () => {
    const samples = [0, 0.25, 0.5, 0.999999, 1];
    for (let attempt = 0; attempt < RETRY_SCHEDULE_LENGTH; attempt++) {
      const cap = retryDelayCapMillis(attempt);
      for (const sample of samples) {
        const delay = nextRetryDelayMillis(attempt, () => sample);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(cap);
        expect(Number.isInteger(delay)).toBe(true);
      }
      expect(nextRetryDelayMillis(attempt, () => 0)).toBe(0);
      expect(nextRetryDelayMillis(attempt, () => 1)).toBe(cap);
    }
  });

  it('clamps NaN and hostile random values to a bounded integer', () => {
    expect(nextRetryDelayMillis(0, () => Number.NaN)).toBe(0);
    expect(nextRetryDelayMillis(0, () => 7)).toBe(2000);
    expect(nextRetryDelayMillis(0, () => -1)).toBe(0);
    expect(nextRetryDelayMillis(0, () => 2)).toBe(2000);
  });

  it('clamps attempts to the schedule range', () => {
    expect(nextRetryDelayMillis(-5, () => 1)).toBe(2000);
    expect(nextRetryDelayMillis(1.7, () => 1)).toBe(4000);
    expect(nextRetryDelayMillis(Number.POSITIVE_INFINITY, () => 1)).toBe(2000);
    expect(nextRetryDelayMillis(1e9, () => 1)).toBe(retryDelayCapMillis(RETRY_SCHEDULE_LENGTH - 1));
    expect(MAX_AUTOMATIC_ATTEMPTS).toBe(6);
    expect(exceededAutomaticAttempts(undefined)).toBe(false);
    expect(exceededAutomaticAttempts(MAX_AUTOMATIC_ATTEMPTS - 1)).toBe(false);
    expect(exceededAutomaticAttempts(MAX_AUTOMATIC_ATTEMPTS)).toBe(true);
  });

  it('is pure: the same inputs give the same delay', () => {
    expect(nextRetryDelayMillis(2, () => 0.3)).toBe(nextRetryDelayMillis(2, () => 0.3));
  });
});

describe('isRetryable', () => {
  it('retries network, timeout, 429 and 5xx failures', () => {
    const retryable: unknown[] = [
      new TypeError('Failed to fetch'),
      new Error('NetworkError when attempting to fetch resource.'),
      new Error('offline'),
      new Error('The operation timed out'),
      { code: 'ETIMEDOUT' },
      { code: 'PGRST000' },
      { status: 429 },
      { status: 500 },
      { status: 503, message: 'Service unavailable' },
      { code: '503' },
    ];
    for (const error of retryable) expect(isRetryable(error)).toBe(true);
  });

  it('never retries auth, permission or validation failures', () => {
    const permanent: unknown[] = [
      { status: 401 },
      { status: 403 },
      { status: 422 },
      { status: 400 },
      { code: 'PGRST301' },
      { code: '42501' },
      { code: 'invalid' },
      new Error('JWT expired'),
      new Error('permission denied for table account_entries'),
      new Error('Invalid operation'),
      new Error('Authentication required'),
    ];
    for (const error of permanent) expect(isRetryable(error)).toBe(false);
  });

  it('retries unknown failures since the outbox is durable and attempts are capped', () => {
    expect(isRetryable(new Error(''))).toBe(true);
    expect(isRetryable({})).toBe(true);
    expect(isRetryable(undefined)).toBe(true);
  });
});

describe('friendly errors', () => {
  it('returns short, honest sentences that never claim success', () => {
    const cases: unknown[] = [new TypeError('Failed to fetch'), { status: 401 }, { status: 403 }, { status: 500 }, { status: 429 }, new Error('Invalid operation'), new SyncValidationError('payload-too-large', 'too big'), undefined];
    for (const error of cases) {
      const copy = friendlySyncError(error);
      expect(copy.length).toBeGreaterThan(10);
      expect(copy.endsWith('.')).toBe(true);
      expect(copy.toLowerCase()).not.toContain('succes');
      expect(copy.toLowerCase()).not.toContain('synced');
      expect(copy.toLowerCase()).not.toContain('saved to');
    }
    expect(friendlySyncError(new TypeError('Failed to fetch'))).toBe('Could not reach the account service. Changes stay saved on this device.');
    expect(friendlySyncError(new SyncValidationError('payload-too-large', 'big'))).toContain('too large');
  });

  it('maps failures to kinds for the status area', () => {
    expect(syncErrorKind(new TypeError('Failed to fetch'))).toBe('offline');
    expect(syncErrorKind({ status: 401 })).toBe('unauthenticated');
    expect(syncErrorKind({ status: 403 })).toBe('forbidden');
    expect(syncErrorKind({ status: 429 })).toBe('rate-limited');
    expect(syncErrorKind({ status: 502 })).toBe('server');
    expect(syncErrorKind({ status: 422 })).toBe('rejected');
    expect(syncErrorKind(new SyncValidationError('rejected', 'bad'))).toBe('rejected');
    expect(syncErrorKind(new SyncValidationError('payload-too-large', 'big'))).toBe('payload-too-large');
    expect(syncErrorKind(undefined)).toBe('unknown');
  });
});

describe('planImport', () => {
  const upload: Entry = { ...book, id: 'c-new', title: 'New local' };
  const sameIdBoth: Entry = { ...book, id: 'b-both', title: 'Same everywhere' };
  const localConflicting: Entry = { ...book, id: 'a-differs', title: 'Local title' };
  const serverConflicting: Entry = { ...book, id: 'a-differs', title: 'Server title' };
  const localAgainstTombstone: Entry = { ...book, id: 'd-tombstone', title: 'Local vs tombstone' };

  function plan() {
    return planImport(
      [upload, sameIdBoth, localConflicting, localAgainstTombstone],
      [
        { id: 'b-both', revision: 2, entry: sameIdBoth },
        { id: 'a-differs', revision: 1, entry: serverConflicting },
        { id: 'd-tombstone', revision: 4, entry: null },
        { id: 'e-server-only', revision: 1, entry: { ...book, id: 'e-server-only' } },
      ],
    );
  }

  it('splits local entries into uploads, conflicts and already-synced counts', () => {
    const result = plan();
    expect(result.uploads).toEqual([upload]);
    expect(result.conflicts).toEqual([{ local: localConflicting, server: { id: 'a-differs', revision: 1, entry: serverConflicting } }, { local: localAgainstTombstone, server: { id: 'd-tombstone', revision: 4, entry: null } }]);
    expect(result.alreadySynced).toBe(1);
  });

  it('returns deterministic order sorted by entry id', () => {
    const reversed = planImport([localAgainstTombstone, someEntry('zz'), someEntry('aa'), upload], []);
    expect(reversed.uploads.map((entry) => entry.id)).toEqual(['aa', 'c-new', 'd-tombstone', 'zz']);
  });

  it('treats equal content as already synced regardless of key order or dropped extras', () => {
    const reordered = { createdAt: sameIdBoth.createdAt, notes: sameIdBoth.notes, tags: [...sameIdBoth.tags], progress: sameIdBoth.progress, color: sameIdBoth.color, status: sameIdBoth.status, type: sameIdBoth.type, title: sameIdBoth.title, id: sameIdBoth.id };
    const result = planImport([sameIdBoth, { ...book, id: 'b-extra' }], [
      { id: 'b-both', revision: 3, entry: reordered },
      { id: 'b-extra', revision: 1, entry: { ...book, id: 'b-extra' } },
    ]);
    expect(result.uploads).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.alreadySynced).toBe(2);
  });

  it('detects conflicts on any differing field, including tags and rating', () => {
    const result = planImport(
      [{ ...book, id: 'tag-diff' }, { ...rated, id: 'rating-diff' }],
      [
        { id: 'tag-diff', revision: 1, entry: { ...book, id: 'tag-diff', tags: [] } },
        { id: 'rating-diff', revision: 1, entry: { ...rated, id: 'rating-diff', rating: 5 } },
      ],
    );
    expect(result.conflicts.map((conflict) => conflict.local.id)).toEqual(['rating-diff', 'tag-diff']);
    expect(result.alreadySynced).toBe(0);
  });

  it('never mutates its inputs', () => {
    const local = [upload, sameIdBoth, localConflicting, localAgainstTombstone];
    const remote: ServerEntry[] = [
      { id: 'b-both', revision: 2, entry: sameIdBoth },
      { id: 'a-differs', revision: 1, entry: serverConflicting },
    ];
    const localSnapshot = JSON.stringify(local);
    const remoteSnapshot = JSON.stringify(remote);
    plan();
    planImport(local, remote);
    expect(JSON.stringify(local)).toBe(localSnapshot);
    expect(JSON.stringify(remote)).toBe(remoteSnapshot);
  });

  it('rejects duplicate ids on either side', () => {
    expectValidationFailure(() => planImport([book, book], []));
    expectValidationFailure(() => planImport([], [{ id: 'one', revision: 1, entry: book }, { id: 'one', revision: 2, entry: book }]));
  });
});

function someEntry(id: string): Entry {
  return { ...book, id };
}

describe('conflictCopy', () => {
  it('produces a new entry without mutating the original', () => {
    const original = book;
    const snapshot = JSON.stringify(original);
    const copy = conflictCopy(original, '2026-02-02T00:00:00.000Z', () => 'copy-id');
    expect(copy).toEqual({ ...book, id: 'copy-id', title: 'Example (conflict copy)', createdAt: '2026-02-02T00:00:00.000Z' });
    expect(copy).not.toBe(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('gives every copy a unique id by default', () => {
    const ids = new Set(Array.from({ length: 50 }, () => conflictCopy(book, NOW).id));
    expect(ids.size).toBe(50);
    expect(ids.has(book.id)).toBe(false);
  });

  it('preserves the rating only when present and rejects an unusable id', () => {
    expect(conflictCopy(rated, NOW, () => 'copy-rated').rating).toBe(4);
    expect(conflictCopy(book, NOW, () => 'copy-plain').rating).toBeUndefined();
    expect(() => conflictCopy(book, NOW, () => book.id)).toThrow();
    expect(() => conflictCopy(book, NOW, () => '')).toThrow();
    expect(() => conflictCopy(book, '  ')).toThrow();
  });

  it('builds a keep-both pending change as a fresh create', () => {
    const change = pending({ entry: book, expectedRevision: 3 });
    const copyChange = conflictCopyChange(change, NOW, () => 'copy-id', () => 'op-copy');
    expect(copyChange).toEqual({ accountId: 'account-a', entryId: 'copy-id', operationId: 'op-copy', expectedRevision: 0, entry: conflictCopy(book, NOW, () => 'copy-id'), createdAt: NOW });
    expect(() => conflictCopyChange(pending({ entry: null }), NOW)).toThrow();
  });
});

describe('pending-change builders', () => {
  it('creates a fresh operation id and validates the entry', () => {
    const change = createChangeFor('account-a', book, NOW, 0, () => 'op-new');
    expect(change).toEqual({ accountId: 'account-a', entryId: 'one', operationId: 'op-new', expectedRevision: 0, entry: book, createdAt: NOW });
    expect(createChangeFor('account-a', book, NOW, 0).operationId).toMatch(/[0-9a-f-]{36}/);
    expect(() => createChangeFor('', book, NOW, 0)).toThrow();
    expect(() => createChangeFor('account-a', book, NOW, -1)).toThrow();
    expect(() => createChangeFor('account-a', { ...book, title: '' }, NOW, 0)).toThrow();
  });

  it('resolves a conflict into a push based on the server revision', () => {
    const conflict = { local: pending({ expectedRevision: 3 }), server: server({ revision: 5, entry: { ...book, title: 'Remote' } }) };
    const resolved = pendingForConflict(conflict, { ...book, title: 'Merged' }, () => 'op-resolve');
    expect(resolved).toEqual({ accountId: 'account-a', entryId: 'one', operationId: 'op-resolve', expectedRevision: 5, entry: { ...book, title: 'Merged' }, createdAt: NOW });
    expect(pendingForConflict(conflict, null, () => 'op-delete').entry).toBeNull();
    expect(() => pendingForConflict(conflict, { ...book, id: 'other' })).toThrow();
  });
});
