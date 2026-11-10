/**
 * Local-first persistence for Stillroom.
 *
 * One IndexedDB database holds:
 * - `entries`: the signed-out local library (unchanged since v1).
 * - v2 account caches, all partitioned by account id so one account can never
 *   observe another account's rows: `account_entries`, `account_outbox`,
 *   `account_meta`, `account_conflicts`, `account_backups`, `account_mutations`.
 * - v3 manifest: a small record of every account that has a cache on this
 *   device, so scheduled work can find pending accounts after a reload.
 *
 * Upgrades are explicit (`MIGRATIONS`), tested against fixtures, and never
 * drop an object store. Every change to a library is written together with its
 * pending outbox operation in a single transaction.
 */
import type { Entry } from './sync-core';

export type { Entry };

const DB = 'stillroom-library';
const LOCAL_STORE = 'entries';
export const ACCOUNT_ENTRIES = 'account_entries';
export const ACCOUNT_OUTBOX = 'account_outbox';
export const ACCOUNT_META = 'account_meta';
export const ACCOUNT_CONFLICTS = 'account_conflicts';
export const ACCOUNT_BACKUPS = 'account_backups';
export const ACCOUNT_MUTATIONS = 'account_mutations';
const MANIFEST_STORE = 'sync_manifest';
export const SCHEMA_VERSION = 3;

let opening: Promise<IDBDatabase> | undefined;

type Migration = (database: IDBDatabase, transaction: IDBTransaction) => void;

/** Each step upgrades from `version()` to `version() + 1` inside `onupgradeneeded`. */
const MIGRATIONS: Record<number, Migration> = {
  // v1: the original local library.
  1: (database) => {
    if (!database.objectStoreNames.contains(LOCAL_STORE)) database.createObjectStore(LOCAL_STORE, { keyPath: 'id' });
  },
  // v2: account-partitioned sync caches and the durable outbox.
  2: (database) => {
    if (!database.objectStoreNames.contains(ACCOUNT_ENTRIES)) database.createObjectStore(ACCOUNT_ENTRIES, { keyPath: ['accountId', 'entryId'] });
    if (!database.objectStoreNames.contains(ACCOUNT_OUTBOX)) database.createObjectStore(ACCOUNT_OUTBOX, { keyPath: ['accountId', 'entryId'] });
    if (!database.objectStoreNames.contains(ACCOUNT_META)) database.createObjectStore(ACCOUNT_META, { keyPath: 'accountId' });
    if (!database.objectStoreNames.contains(ACCOUNT_CONFLICTS)) database.createObjectStore(ACCOUNT_CONFLICTS, { keyPath: ['accountId', 'entryId'] });
    if (!database.objectStoreNames.contains(ACCOUNT_BACKUPS)) database.createObjectStore(ACCOUNT_BACKUPS, { keyPath: ['accountId', 'readyAt'] });
    if (!database.objectStoreNames.contains(ACCOUNT_MUTATIONS)) database.createObjectStore(ACCOUNT_MUTATIONS, { keyPath: ['accountId', 'mutationId'] });
  },
  // v3: manifest of cached accounts (used to resume interrupted work safely).
  3: (database) => {
    if (!database.objectStoreNames.contains(MANIFEST_STORE)) database.createObjectStore(MANIFEST_STORE, { keyPath: 'accountId' });
  },
};

function db(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, SCHEMA_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      if (!transaction) return;
      const from = event.oldVersion;
      for (let version = from + 1; version <= SCHEMA_VERSION; version++) MIGRATIONS[version]?.(database, transaction);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      opening = undefined;
      reject(request.error ?? new Error('Local storage could not be opened.'));
    };
    request.onblocked = () => {
      opening = undefined;
      reject(new Error('Storage is blocked by another open tab. Close other Stillroom tabs and try again.'));
    };
  }));
}

/** Tests and sign-out flows may close the connection; the next call reopens it. */
export function closeDatabase(): void {
  void opening?.then((database) => database.close()).catch(() => undefined);
  opening = undefined;
}

function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return localRequest(mode, operation);
}

/**
 * Runs one request against the local library store and resolves with its
 * result. IndexedDB delivers `result` only through `request.onsuccess`, so the
 * value is captured on success and the outer promise settles only after the
 * transaction completes.
 */
function localRequest<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return runTransaction([LOCAL_STORE], mode, (transaction) => {
    const store = transaction.objectStore(LOCAL_STORE);
    const request = operation(store);
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('Storage operation failed.'));
    });
  });
}

/**
 * Runs one or more operations inside a transaction and resolves once the
 * transaction has completed with the work's value. `work` may return a plain
 * value or a promise (for reads); both the value and the transaction's settle
 * are awaited before the caller resumes.
 */
function runTransaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  return db().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(stores, mode);
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Storage transaction could not start.'));
          return;
        }
        let output: T | undefined;
        let workError: unknown;
        let workDone = false;
        let txDone = false;
        let settled = false;
        const finish = () => {
          if (settled || !workDone || !txDone) return;
          settled = true;
          if (workError !== undefined) reject(workError instanceof Error ? workError : new Error('Storage operation failed.'));
          else resolve(output as T);
        };
        try {
          const result = work(transaction);
          Promise.resolve(result).then(
            (value) => {
              output = value;
              workDone = true;
              finish();
            },
            (error) => {
              workError = error;
              workDone = true;
              finish();
            },
          );
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            /* already aborting */
          }
          reject(error instanceof Error ? error : new Error('Storage operation failed.'));
          return;
        }
        transaction.oncomplete = () => {
          txDone = true;
          finish();
        };
        transaction.onerror = () => {
          if (settled) return;
          settled = true;
          reject(transaction.error ?? new Error('Storage transaction failed.'));
        };
        transaction.onabort = () => {
          if (settled) return;
          settled = true;
          reject(transaction.error ?? new Error('Storage transaction was aborted.'));
        };
      }),
  );
}

/** Reads a single record and resolves with its value once the request succeeds. */
function getOne<T>(store: IDBObjectStore, key: IDBValidKey | IDBKeyRange): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error('Storage read failed.'));
  });
}

/** Reads every record matching an optional key/range and resolves on success. */
function getAllRequest<T>(store: IDBObjectStore, key?: IDBValidKey | IDBKeyRange | null): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const request = store.getAll(key ?? undefined);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error('Storage read failed.'));
  });
}

// ---------------------------------------------------------------------------
// Local (signed-out) library: the original API, unchanged in behavior.
// ---------------------------------------------------------------------------

export const listEntries = () => transaction<Entry[]>('readonly', (store) => store.getAll());
export const putEntry = (entry: Entry) => transaction<IDBValidKey>('readwrite', (store) => store.put(entry));
export const deleteEntry = (id: string) => transaction<undefined>('readwrite', (store) => store.delete(id));

export function makeBackup(entries: Entry[]) {
  return JSON.stringify({ format: 'stillroom', version: 1, exportedAt: new Date().toISOString(), entries }, null, 2);
}

const TYPES = new Set(['Game', 'Movie', 'TV / Anime', 'Manga', 'Book', 'Music']);
const STATUSES = new Set(['Planned', 'In progress', 'Completed', 'Paused', 'Dropped']);
const COLORS = new Set(['blue', 'ochre', 'rose', 'slate', 'violet', 'teal']);

/** Rebuilds a trusted Entry from untrusted data, or returns undefined. Shared with sync validation. */
export function sanitizeEntry(value: unknown): Entry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const string = (key: string, max: number): string | undefined => {
    const field = raw[key];
    return typeof field === 'string' && field.length <= max ? field : undefined;
  };
  const id = string('id', 200);
  const title = string('title', 300);
  const type = string('type', 40);
  const status = string('status', 40);
  const color = string('color', 40);
  const progress = string('progress', 200);
  const notes = string('notes', 50000);
  const createdAt = string('createdAt', 40);
  if (!id || !id.trim() || !title || !title.trim() || !type || !status || !color || progress === undefined || notes === undefined || !createdAt) return undefined;
  if (!TYPES.has(type) || !STATUSES.has(status) || !COLORS.has(color)) return undefined;
  const tags = raw.tags;
  if (!Array.isArray(tags) || tags.length > 100 || !tags.every((tag) => typeof tag === 'string' && tag.length > 0 && tag.length <= 60)) return undefined;
  const rating = raw.rating;
  if (rating !== undefined && (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5)) return undefined;
  return {
    id,
    title,
    type,
    status,
    color,
    progress,
    tags: [...new Set(tags as string[])],
    ...(rating === undefined ? {} : { rating }),
    notes,
    createdAt,
  };
}

export function parseBackup(text: string): Entry[] {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object') throw new Error('Invalid backup');
  const data = raw as Record<string, unknown>;
  if (data.format !== 'stillroom' || data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 10000) throw new Error('Unsupported backup');
  const ids = new Set<string>();
  const entries: Entry[] = [];
  for (const value of data.entries) {
    const entry = sanitizeEntry(value);
    if (!entry || ids.has(entry.id)) throw new Error('Invalid entry');
    ids.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

export function replaceEntries(entries: Entry[]): Promise<void> {
  return runTransaction([LOCAL_STORE], 'readwrite', (transaction) => {
    const store = transaction.objectStore(LOCAL_STORE);
    store.clear();
    for (const entry of entries) store.put(entry);
  }).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Account-partitioned sync caches.
// ---------------------------------------------------------------------------

export type AccountRecord = { accountId: string; entryId: string; entry: Entry | null; revision: number };
export type OutboxRecord = {
  accountId: string;
  entryId: string;
  operationId: string;
  expectedRevision: number;
  entry: Entry | null;
  createdAt: string;
  retryCount: number;
  nextAttemptAt: string;
  lastError: string | null;
};
export type MutationRecord =
  | { accountId: string; mutationId: string; kind: 'import'; state: 'staged' }
  | { accountId: string; mutationId: string; kind: 'import'; state: 'revert'; entryIds: string[] };
export type AccountMeta = {
  accountId: string;
  cursorRevision: number;
  importedAt: string | null;
  importDismissedAt: string | null;
  lastSyncedAt: string | null;
  schema: 1;
};
export type ConflictRecord = { accountId: string; entryId: string; local: OutboxRecord | null; server: AccountRecord; detectedAt: string };
export type BackupRecord = { accountId: string; readyAt: string; changes: number; interrupted: boolean };

const nowIso = () => new Date().toISOString();
/** Composite key helper. Returns a mutable tuple so it satisfies `IDBArrayKey`. */
const keyOf = (accountId: string, entryId: string): [string, string] => [accountId, entryId];

export async function getMeta(accountId: string): Promise<AccountMeta> {
  const records = await getAllRequest<AccountMeta>(await storeFor(ACCOUNT_META), accountId);
  return records[0] ?? { accountId, cursorRevision: 0, importedAt: null, importDismissedAt: null, lastSyncedAt: null, schema: 1 };
}

async function storeFor(name: string): Promise<IDBObjectStore> {
  // Helper kept for readability: read a single store through a short transaction.
  const database = await db();
  return database.transaction(name, 'readonly').objectStore(name);
}

export function putMeta(meta: AccountMeta): Promise<void> {
  return runTransaction([ACCOUNT_META], 'readwrite', (transaction) => {
    transaction.objectStore(ACCOUNT_META).put(meta);
  }).then(() => undefined);
}

export function ensureMeta(accountId: string): Promise<AccountMeta> {
  return getMeta(accountId).then((meta) => putMeta(meta).then(() => meta));
}

/** Latest known server state per entry (acknowledged revisions plus pending local edits). */
export function listAccountEntries(accountId: string): Promise<AccountRecord[]> {
  return runTransaction([ACCOUNT_ENTRIES], 'readonly', (transaction) => getAllRequest<AccountRecord>(transaction.objectStore(ACCOUNT_ENTRIES), IDBKeyRange.bound([accountId, ''], [accountId, '\uffff']))).then((rows) => rows.filter((row) => row.accountId === accountId));
}

export function getAccountEntry(accountId: string, entryId: string): Promise<AccountRecord | undefined> {
  return runTransaction([ACCOUNT_ENTRIES], 'readonly', (transaction) => getOne<AccountRecord>(transaction.objectStore(ACCOUNT_ENTRIES), keyOf(accountId, entryId)));
}

export function listPending(accountId: string): Promise<OutboxRecord[]> {
  return runTransaction([ACCOUNT_OUTBOX], 'readonly', (transaction) => getAllRequest<OutboxRecord>(transaction.objectStore(ACCOUNT_OUTBOX), IDBKeyRange.bound([accountId, ''], [accountId, '\uffff']))).then((rows) => rows.filter((row) => row.accountId === accountId));
}

export function listConflicts(accountId: string): Promise<ConflictRecord[]> {
  return runTransaction([ACCOUNT_CONFLICTS], 'readonly', (transaction) => getAllRequest<ConflictRecord>(transaction.objectStore(ACCOUNT_CONFLICTS), IDBKeyRange.bound([accountId, ''], [accountId, '\uffff']))).then((rows) => rows.filter((row) => row.accountId === accountId));
}

export function listBackups(accountId: string): Promise<BackupRecord[]> {
  return runTransaction([ACCOUNT_BACKUPS], 'readonly', (transaction) => getAllRequest<BackupRecord>(transaction.objectStore(ACCOUNT_BACKUPS), IDBKeyRange.bound([accountId, ''], [accountId, '\uffff']))).then((rows) => rows.filter((row) => row.accountId === accountId));
}

export function listMutations(accountId: string): Promise<MutationRecord[]> {
  return runTransaction([ACCOUNT_MUTATIONS], 'readonly', (transaction) => getAllRequest<MutationRecord>(transaction.objectStore(ACCOUNT_MUTATIONS), IDBKeyRange.bound([accountId, ''], [accountId, '\uffff']))).then((rows) => rows.filter((row) => row.accountId === accountId));
}

function deleteOutbox(transaction: IDBTransaction, accountId: string, entryId: string): void {
  transaction.objectStore(ACCOUNT_OUTBOX).delete(keyOf(accountId, entryId));
}

function deleteConflict(transaction: IDBTransaction, accountId: string, entryId: string): void {
  transaction.objectStore(ACCOUNT_CONFLICTS).delete(keyOf(accountId, entryId));
}

export function markAccountCached(accountId: string): Promise<void> {
  return runTransaction([MANIFEST_STORE], 'readwrite', (transaction) => {
    transaction.objectStore(MANIFEST_STORE).put({ accountId, seenAt: nowIso() });
  }).then(() => undefined);
}

export function listCachedAccounts(): Promise<string[]> {
  return runTransaction([MANIFEST_STORE], 'readonly', (transaction) => getAllRequest<{ accountId: string }>(transaction.objectStore(MANIFEST_STORE))).then((rows) => rows.map((row) => row.accountId));
}

/**
 * Records a local library change and its outbox operation atomically.
 * `record` is the new local view (with its pending revision); `operation` must
 * describe the same account and entry and the last acknowledged revision.
 */
export function queueAccountChange(record: AccountRecord, operation: OutboxRecord): Promise<void> {
  if (record.accountId !== operation.accountId || record.entryId !== operation.entryId) throw new Error('Mismatched sync operation');
  if (record.entry !== null && operation.entry !== null && JSON.stringify(record.entry) !== JSON.stringify(operation.entry)) throw new Error('Local view does not match the queued change');
  return runTransaction([ACCOUNT_ENTRIES, ACCOUNT_OUTBOX], 'readwrite', (transaction) => {
    transaction.objectStore(ACCOUNT_ENTRIES).put(record);
    transaction.objectStore(ACCOUNT_OUTBOX).put(operation);
  }).then(() => undefined);
}

/** Saves the merged local view (conflict resolution) and rewrites the pending operation. */
export function replaceQueuedChange(record: AccountRecord, operation: OutboxRecord): Promise<void> {
  if (record.accountId !== operation.accountId || record.entryId !== operation.entryId) throw new Error('Mismatched sync operation');
  return runTransaction([ACCOUNT_ENTRIES, ACCOUNT_OUTBOX, ACCOUNT_CONFLICTS], 'readwrite', (transaction) => {
    transaction.objectStore(ACCOUNT_ENTRIES).put(record);
    transaction.objectStore(ACCOUNT_OUTBOX).put(operation);
    deleteConflict(transaction, operation.accountId, operation.entryId);
  }).then(() => undefined);
}

/**
 * Applies a server row (acknowledgement or freshly pulled data) and updates the
 * outbox. A server row strictly newer than the queued change is kept as the
 * pending expectation so the next attempt conflicts instead of overwriting.
 */
export function applyServerRow(accountId: string, row: AccountRecord): Promise<void> {
  if (row.accountId !== accountId) throw new Error('Server row belongs to another account');
  return runTransaction([ACCOUNT_ENTRIES, ACCOUNT_OUTBOX], 'readwrite', (transaction) => {
    transaction.objectStore(ACCOUNT_ENTRIES).put(row);
    return getOne<OutboxRecord>(transaction.objectStore(ACCOUNT_OUTBOX), keyOf(accountId, row.entryId)).then((pending) => {
      if (!pending) return;
      if (pending.expectedRevision < row.revision) {
        const next: OutboxRecord = { ...pending, expectedRevision: row.revision, retryCount: 0, nextAttemptAt: nowIso(), lastError: null };
        transaction.objectStore(ACCOUNT_OUTBOX).put(next);
      }
    });
  });
}

export function getPending(accountId: string, entryId: string): Promise<OutboxRecord | undefined> {
  return runTransaction([ACCOUNT_OUTBOX], 'readonly', (transaction) => getOne<OutboxRecord>(transaction.objectStore(ACCOUNT_OUTBOX), keyOf(accountId, entryId)));
}

export type AcknowledgeInput = { accountId: string; entryId: string; operationId: string; revision: number; serverRevision: AcknowledgeRevision };
/** The revision the local cache should adopt for the acknowledged operation. */
export type AcknowledgeRevision = number;

export type AckOutcome = 'applied' | 'superseded' | 'discarded' | 'unknown-operation';

/**
 * Marks one operation synced only if the outbox still holds that exact
 * operation. A newer offline edit queued while the request was in flight stays
 * queued (superseded). Reads are not used inside the writer transaction, so a
 * single get/put pair inside one readwrite transaction is performed here.
 */
export function acknowledgeChange(accountId: string, entryId: string, operationId: string, serverRevision: number): Promise<AckOutcome> {
  return runTransaction([ACCOUNT_OUTBOX, ACCOUNT_ENTRIES, ACCOUNT_CONFLICTS], 'readwrite', (transaction) => {
    const outbox = transaction.objectStore(ACCOUNT_OUTBOX);
    const cache = transaction.objectStore(ACCOUNT_ENTRIES);
    const conflicts = transaction.objectStore(ACCOUNT_CONFLICTS);
    const key = keyOf(accountId, entryId);
    return Promise.all([getOne<OutboxRecord>(outbox, key), getOne<AccountRecord>(cache, key)]).then(([pending, record]) => {
      if (record) cache.put({ ...record, revision: Math.max(record.revision, serverRevision) });
      if (!pending) return 'unknown-operation' as AckOutcome;
      if (pending.operationId === operationId) {
        // The head of the outbox is exactly the change the server just acknowledged:
        // nothing newer was queued while it was in flight, so it is fully synced.
        outbox.delete(key);
        conflicts.delete(key);
        return 'applied' as AckOutcome;
      }
      // A newer queued edit superseded the acknowledged operation. Rebase that
      // newer edit to the acknowledged server revision so its next attempt
      // conflicts instead of silently overwriting the server state.
      outbox.put({ ...pending, expectedRevision: Math.max(pending.expectedRevision, serverRevision), retryCount: 0, nextAttemptAt: nowIso(), lastError: null });
      return 'superseded' as AckOutcome;
    });
  });
}

/** Marks an applied server revision for an entry with no pending work (pull path ack). */
export function acknowledgeRecord(accountId: string, entryId: string, operationId: string, serverRevision: number): Promise<AckOutcome> {
  return acknowledgeChange(accountId, entryId, operationId, serverRevision);
}

export function discardChange(accountId: string, entryId: string, operationId: string): Promise<boolean> {
  return runTransaction([ACCOUNT_OUTBOX], 'readwrite', (transaction) => {
    const outbox = transaction.objectStore(ACCOUNT_OUTBOX);
    return getOne<OutboxRecord>(outbox, keyOf(accountId, entryId)).then((pending) => {
      if (pending && pending.operationId === operationId) {
        outbox.delete(keyOf(accountId, entryId));
        return true;
      }
      return false;
    });
  });
}

export function recordFailure(accountId: string, entryId: string, operationId: string, patch: Pick<OutboxRecord, 'retryCount' | 'nextAttemptAt' | 'lastError'>): Promise<void> {
  return runTransaction([ACCOUNT_OUTBOX], 'readwrite', (transaction) => {
    const outbox = transaction.objectStore(ACCOUNT_OUTBOX);
    return getOne<OutboxRecord>(outbox, keyOf(accountId, entryId)).then((pending) => {
      if (pending && pending.operationId === operationId) outbox.put({ ...pending, ...patch });
    });
  });
}

export function storeConflict(record: ConflictRecord): Promise<void> {
  return runTransaction([ACCOUNT_CONFLICTS], 'readwrite', (transaction) => {
    transaction.objectStore(ACCOUNT_CONFLICTS).put(record);
  }).then(() => undefined);
}

export function clearConflict(accountId: string, entryId: string): Promise<void> {
  return runTransaction([ACCOUNT_CONFLICTS], 'readwrite', (transaction) => {
    deleteConflict(transaction, accountId, entryId);
  }).then(() => undefined);
}

/**
 * Adopts a server row as the account's authoritative version for one entry:
 * writes the cache record, drops any queued local change for that entry, and
 * clears its conflict marker — all in one transaction, so the local library can
 * never end up half-resolved. This is what "use theirs" and "keep both" need for
 * the original entry (the user has decided the server version wins there).
 */
export function acceptServerRow(accountId: string, record: AccountRecord): Promise<void> {
  if (record.accountId !== accountId) throw new Error('Server row belongs to another account');
  if (!accountId) throw new Error('Account required');
  return runTransaction([ACCOUNT_ENTRIES, ACCOUNT_OUTBOX, ACCOUNT_CONFLICTS], 'readwrite', (transaction) => {
    transaction.objectStore(ACCOUNT_ENTRIES).put(record);
    deleteOutbox(transaction, accountId, record.entryId);
    deleteConflict(transaction, accountId, record.entryId);
  }).then(() => undefined);
}

/** What a pull did: rows adopted, and entries where a pending edit blocked one. */
export type CacheServerRowsResult = { cached: number; conflicted: string[] };

/**
 * Pulls a server snapshot into the cache without ever discarding unacknowledged
 * local work. A row whose entry still has a pending outbox change never replaces
 * the local version: when the pulled row has moved past the revision that change
 * was based on, the divergence is recorded as a conflict for the user to resolve
 * instead of silently overwriting the edit. Rows with no pending work are
 * adopted as before.
 */
export function cacheServerRows(accountId: string, rows: AccountRecord[]): Promise<CacheServerRowsResult> {
  const owned = rows.filter((row) => row.accountId === accountId);
  if (owned.length === 0) return Promise.resolve({ cached: 0, conflicted: [] });
  const conflicted: string[] = [];
  let cached = 0;
  return runTransaction([ACCOUNT_ENTRIES, ACCOUNT_OUTBOX, ACCOUNT_CONFLICTS], 'readwrite', async (transaction) => {
    const entries = transaction.objectStore(ACCOUNT_ENTRIES);
    const outbox = transaction.objectStore(ACCOUNT_OUTBOX);
    const conflicts = transaction.objectStore(ACCOUNT_CONFLICTS);
    for (const row of owned) {
      const pending = await getOne<OutboxRecord | undefined>(outbox, keyOf(accountId, row.entryId));
      if (!pending) {
        entries.put(row);
        cached += 1;
        continue;
      }
      // An unacknowledged local change owns this entry's cache slot. Keep it;
      // a pulled row that disagrees with its base revision is a divergence.
      if (pending.expectedRevision !== row.revision) {
        conflicts.put({ accountId, entryId: row.entryId, local: pending, server: row, detectedAt: nowIso() } satisfies ConflictRecord);
        conflicted.push(row.entryId);
      }
    }
  }).then(() => ({ cached, conflicted }));
}

export function deleteCachedEntry(accountId: string, entryId: string): Promise<void> {
  return runTransaction([ACCOUNT_ENTRIES], 'readwrite', (transaction) => {
    if (accountId === '') throw new Error('Account required');
    transaction.objectStore(ACCOUNT_ENTRIES).delete(keyOf(accountId, entryId));
  }).then(() => undefined);
}

export function putBackup(backup: BackupRecord): Promise<void> {
  return runTransaction([ACCOUNT_BACKUPS], 'readwrite', (transaction) => {
    transaction.objectStore(ACCOUNT_BACKUPS).put(backup);
  }).then(() => undefined);
}

export function deleteBackup(accountId: string, readyAt: string): Promise<void> {
  return runTransaction([ACCOUNT_BACKUPS], 'readwrite', (transaction) => {
    transaction.objectStore(ACCOUNT_BACKUPS).delete(keyOf(accountId, readyAt));
  }).then(() => undefined);
}

export function putMutation(mutation: MutationRecord): Promise<void> {
  return runTransaction([ACCOUNT_MUTATIONS], 'readwrite', (transaction) => {
    transaction.objectStore(ACCOUNT_MUTATIONS).put(mutation);
  }).then(() => undefined);
}

export function deleteMutation(accountId: string, mutationId: string): Promise<void> {
  return runTransaction([ACCOUNT_MUTATIONS], 'readwrite', (transaction) => {
    transaction.objectStore(ACCOUNT_MUTATIONS).delete([accountId, mutationId]);
  }).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Import: copy the signed-out library into an account without touching it.
// ---------------------------------------------------------------------------

/**
 * Copies every local entry into the account cache and queues a create for each.
 * The signed-out library is never modified. Entries this account already knows
 * are skipped (and reported) instead of being overwritten.
 */
export async function stageLocalImport(accountId: string): Promise<{ staged: number; skipped: number }> {
  if (!accountId) throw new Error('Account required');
  const staged: string[] = [];
  const skipped: string[] = [];
  await runTransaction([LOCAL_STORE, ACCOUNT_ENTRIES, ACCOUNT_OUTBOX], 'readwrite', async (transaction) => {
    const local = transaction.objectStore(LOCAL_STORE);
    const accounts = transaction.objectStore(ACCOUNT_ENTRIES);
    const outbox = transaction.objectStore(ACCOUNT_OUTBOX);
    const entries = await getAllRequest<Entry>(local);
    for (const entry of entries) {
      const key = keyOf(accountId, entry.id);
      const [existing, pending] = await Promise.all([getOne<AccountRecord | undefined>(accounts, key), getOne<OutboxRecord | undefined>(outbox, key)]);
      if (existing || pending) {
        skipped.push(entry.id);
        continue;
      }
      const createdAt = nowIso();
      accounts.put({ accountId, entryId: entry.id, entry, revision: 0 } satisfies AccountRecord);
      outbox.put({ accountId, entryId: entry.id, operationId: crypto.randomUUID(), expectedRevision: 0, entry, createdAt, retryCount: 0, nextAttemptAt: createdAt, lastError: null } satisfies OutboxRecord);
      staged.push(entry.id);
    }
  });
  return { staged: staged.length, skipped: skipped.length };
}

/** Undoes a staged import: only entries that never reached the server are removed. */
export async function revertStagedImport(accountId: string, entryIds: string[]): Promise<number> {
  let removed = 0;
  await runTransaction([ACCOUNT_ENTRIES, ACCOUNT_OUTBOX], 'readwrite', async (transaction) => {
    const accounts = transaction.objectStore(ACCOUNT_ENTRIES);
    const outbox = transaction.objectStore(ACCOUNT_OUTBOX);
    for (const entryId of entryIds) {
      const key = keyOf(accountId, entryId);
      const [change, cached] = await Promise.all([getOne<OutboxRecord | undefined>(outbox, key), getOne<AccountRecord | undefined>(accounts, key)]);
      if (change && change.expectedRevision === 0 && change.retryCount === 0) {
        outbox.delete(key);
        const current = await getOne<AccountRecord | undefined>(accounts, key);
        if (current && current.revision === 0) {
          accounts.delete(key);
          removed++;
        }
      }
      void cached;
    }
  });
  return removed;
}

/** Removes every cached record for one account. Never touches the signed-out library. */
export async function clearAccountCache(accountId: string): Promise<void> {
  if (!accountId) throw new Error('Account required');
  const range = IDBKeyRange.bound([accountId, ''], [accountId, '\uffff']);
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([ACCOUNT_ENTRIES, ACCOUNT_OUTBOX, ACCOUNT_META, ACCOUNT_CONFLICTS, ACCOUNT_BACKUPS, ACCOUNT_MUTATIONS, MANIFEST_STORE], 'readwrite');
    for (const name of [ACCOUNT_ENTRIES, ACCOUNT_OUTBOX, ACCOUNT_CONFLICTS, ACCOUNT_BACKUPS, ACCOUNT_MUTATIONS]) transaction.objectStore(name).delete(range);
    transaction.objectStore(ACCOUNT_META).delete(accountId);
    transaction.objectStore(MANIFEST_STORE).delete(accountId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear the cached account data.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Clearing the cached account data was aborted.'));
  });
}
