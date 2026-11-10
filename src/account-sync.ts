/**
 * Account sync transport: drives the durable outbox and the account cache
 * (src/storage.ts) against the Supabase RPC functions (src/account-client.ts /
 * supabase/migrations/0001_account_sync.sql).
 *
 * This module is React-free and keeps all domain decisions in src/sync-core.ts.
 * It never fabricates a "synced" result: a change is only acknowledged after the
 * server returns `applied`/`already_applied`, and every incoming server row is
 * validated before it touches the account cache.
 */

import type { SupabaseClient, Session } from '@supabase/supabase-js';
import {
  acknowledgeChange,
  applyServerRow,
  cacheServerRows,
  getPending,
  listPending,
  recordFailure,
  storeConflict,
  type AccountRecord,
  type OutboxRecord,
} from './storage';
import {
  parseServerEntry,
  reconcile,
  assertChangeForAccount,
  isRetryable,
  nextRetryDelayMillis,
  exceededAutomaticAttempts,
  entryPayloadSize,
  MAX_PAYLOAD_BYTES,
  syncErrorKind,
  type PendingChange,
  type ServerEntry,
} from './sync-core';

const PAGE_LIMIT = 200;

/** The raw RPC response row for one account entry (untrusted, network/DB input). */
export type ServerRow = { id: string; revision: number; payload: unknown; deleted: boolean; sync_seq?: number; updated_at?: string };

/** The raw RPC response for one `apply_entry_change` call. */
export type ApplyResult = { outcome: 'applied' | 'already_applied' | 'conflict' | string; revision: number; payload: unknown; deleted: boolean; applied_revision: number | null };

export type SyncReport = {
  pushed: number;
  pulled: number;
  conflictsDetected: number;
  waiting: number;
  retries: number;
  lastError: string | null;
  errorKind: string | null;
  paused: boolean;
};

/** The transport dependencies, injectable so the UI can substitute a mock client. */
export type TransportClient = {
  rpc<R>(fn: string, args: Record<string, unknown>): Promise<{ data: R | null; error: unknown }>;
  /**
   * The identity this transport is currently authenticated as, read from the
   * live session — never a caller-supplied id. Re-checked around every await so a
   * sign-in/sign-out mid-sync cannot move data across accounts.
   */
  currentUserId(): Promise<string | null>;
};

export class SyncAccountError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'SyncAccountError';
  }
}

/** Raised when the authenticated session no longer matches the account being synced. */
export class SyncIdentityError extends SyncAccountError {
  constructor(message = 'Sync stopped because the signed-in account changed. Nothing was sent or saved to the account.') {
    super(message, false);
    this.name = 'SyncIdentityError';
  }
}

/**
 * Proves the transport is still authenticated as `accountId`. Called before every
 * pull/push request and again after each one returns, so a session switch during
 * async work aborts the pass instead of labelling one account's rows with another
 * account's id or uploading queued data under the wrong session.
 */
export async function assertAuthenticatedAccount(client: TransportClient, accountId: string): Promise<void> {
  if (accountId.length === 0) throw new SyncIdentityError('Sync needs a signed-in account before it can run.');
  const authenticated = await client.currentUserId();
  if (authenticated !== accountId) throw new SyncIdentityError();
}

function sessionError(error: unknown): SyncAccountError {
  if (isRetryable(error)) return new SyncAccountError('Sync could not reach the account service yet.', true);
  return new SyncAccountError('Sync stopped because this change is not allowed.', false);
}

/** Validates and rebuilds a ServerEntry from a database row (deleted → tombstone). */
export function parseServerRow(row: unknown): ServerRow {
  if (!row || typeof row !== 'object') throw new Error('Server row is not an object.');
  const raw = row as Record<string, unknown>;
  const id = raw.id;
  const revision = raw.revision;
  const deleted = raw.deleted;
  if (typeof id !== 'string' || id.length === 0) throw new Error('Server row id is invalid.');
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Server row revision is invalid.');
  if (typeof deleted !== 'boolean') throw new Error('Server row deleted flag is invalid.');
  const sequence = raw.sync_seq;
  if (sequence !== undefined && (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0)) {
    throw new Error('Server row sync sequence is invalid.');
  }
  return { id, revision, payload: raw.payload, deleted, ...(sequence === undefined ? {} : { sync_seq: sequence }) };
}

/**
 * Validates one row from the pull RPC. Unlike a write acknowledgement, a pulled
 * row MUST carry its `sync_seq`, because that value is the resume cursor: without
 * it we could not page safely, and silently falling back would re-read the whole
 * account (or, worse, skip rows). A missing or malformed sequence fails closed.
 */
export function parsePullRow(row: unknown): ServerRow & { sync_seq: number } {
  const parsed = parseServerRow(row);
  if (parsed.sync_seq === undefined) throw new Error('Pulled server row is missing its sync sequence.');
  return { ...parsed, sync_seq: parsed.sync_seq };
}

export function rowToServerEntry(row: ServerRow): ServerEntry {
  if (row.deleted) return { id: row.id, revision: row.revision, entry: null };
  const entry = parseServerEntry({ id: row.id, revision: row.revision, entry: row.payload }, row.id).entry;
  return { id: row.id, revision: row.revision, entry };
}

/**
 * Fetches all caller-owned entries in pages of `PAGE_LIMIT`, starting just above
 * `afterSeq` (or from the beginning when null). Paging resumes from each page's
 * last `sync_seq`, which the server allocates in commit order under a per-owner
 * lock — so a page boundary cannot skip rows that share a timestamp. Validates
 * every row; a malformed row (including a missing sequence) aborts the pull
 * (fail closed) so no untrusted content reaches the cache. When `accountId` is
 * supplied the authenticated identity is verified before every request and again
 * after it returns, so a page fetched for one session is never consumed by another.
 */
export async function pullAccountEntries(client: TransportClient, afterSeq: number | null, accountId?: string): Promise<ServerEntry[]> {
  const out: ServerEntry[] = [];
  let cursor: number | null = afterSeq;
  for (;;) {
    if (accountId !== undefined) await assertAuthenticatedAccount(client, accountId);
    const { data, error } = await client.rpc<ServerRow[]>('list_account_entries', { p_after_seq: cursor, p_limit: PAGE_LIMIT });
    if (accountId !== undefined) await assertAuthenticatedAccount(client, accountId);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    const rows = page.map((rawRow) => parsePullRow(rawRow));
    for (const row of rows) out.push(rowToServerEntry(row));
    if (rows.length < PAGE_LIMIT) break;
    // Resuming strictly above the highest sequence seen cannot repeat a row.
    cursor = rows[rows.length - 1].sync_seq;
  }
  return out;
}

/** Maps a validated local change onto its RPC payload (create/update/deletion). */
export function changePayload(change: PendingChange): { payload: unknown; deleted: boolean } {
  if (change.entry === null) return { payload: {}, deleted: true };
  const size = entryPayloadSize(change.entry);
  if (size > MAX_PAYLOAD_BYTES) throw new Error('Payload too large');
  return { payload: change.entry, deleted: false };
}

function toAccountRecord(accountId: string, server: ServerEntry): AccountRecord {
  return { accountId, entryId: server.id, entry: server.entry, revision: server.revision };
}

/**
 * Applies one server row to the account cache, rebasing any pending change whose
 * expectation is now behind the acknowledged revision so the next attempt
 * conflicts instead of silently overwriting the fresh server state.
 */
async function absorbServerRow(accountId: string, server: ServerEntry): Promise<void> {
  await applyServerRow(accountId, toAccountRecord(accountId, server));
}

/**
 * Pushes one durable change and commits the result atomically on the client.
 * Returns what happened so the scheduler can count and schedule the next step —
 * never a fabricated "synced" state.
 */
export async function pushChange(client: TransportClient, accountId: string, change: OutboxRecord): Promise<'applied' | 'already_applied' | 'conflict' | 'error'> {
  assertChangeForAccount(change, accountId);
  await assertAuthenticatedAccount(client, accountId);
  const { payload, deleted } = changePayload(change);
  const { data, error } = await client.rpc<unknown>('apply_entry_change', {
    p_id: change.entryId,
    p_operation_id: change.operationId,
    p_expected_revision: change.expectedRevision,
    p_payload: payload,
    p_deleted: deleted,
  });
  // The session can change while the request is in flight: prove the identity
  // again before the result is allowed to touch this account's local state.
  await assertAuthenticatedAccount(client, accountId);
  if (error) throw error;
  // PostgREST returns SETOF / TABLE results as an array, even for one row.
  // Reject missing, ambiguous, and malformed results before touching local data.
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== 'object' || Array.isArray(data[0])) {
    throw new Error('The account service returned an invalid result for this change.');
  }
  const result = data[0] as Record<string, unknown>;
  const outcome = result.outcome;
  if (outcome === 'applied' || outcome === 'already_applied') {
    // The server owns this operation (applied just now, or applied by an earlier
    // retry). Adopt its current row and clear the outbox entry atomically.
    const serverRow = parseServerRow({ id: change.entryId, revision: result.revision, payload: result.payload, deleted: result.deleted });
    const server = rowToServerEntry(serverRow);
    await absorbServerRow(accountId, server);
    await acknowledgeChange(accountId, change.entryId, change.operationId, serverRow.revision);
    return outcome === 'applied' ? 'applied' : 'already_applied';
  }
  if (outcome === 'conflict') {
    const serverRow = parseServerRow({ id: change.entryId, revision: result.revision, payload: result.payload, deleted: result.deleted });
    const server = rowToServerEntry(serverRow);
    await storeConflict({
      accountId,
      entryId: change.entryId,
      local: change,
      server: toAccountRecord(accountId, server),
      detectedAt: new Date().toISOString(),
    });
    return 'conflict';
  }
  throw new Error('The account service returned an unknown result.');
}

/**
 * Runs one reconciliation pass: pull, then push each queued change. Pending
 * changes whose expectation does not match the pulled (or previously pulled)
 * server row become conflicts; nothing is dropped. Every network step is fenced
 * by an authenticated-identity check, so a session switch mid-pass aborts with a
 * `SyncIdentityError` before anything is cached or sent for the wrong account.
 * Returns an honest report.
 */
export async function syncPending(client: TransportClient, accountId: string): Promise<SyncReport> {
  const report: SyncReport = { pushed: 0, pulled: 0, conflictsDetected: 0, waiting: 0, retries: 0, lastError: null, errorKind: null, paused: false };
  const now = new Date().toISOString();

  await assertAuthenticatedAccount(client, accountId);
  const serverRows = await pullAccountEntries(client, null, accountId);
  const records = serverRows.map((server) => toAccountRecord(accountId, server));
  // The pull itself refuses to overwrite unacknowledged local edits and reports
  // which entries diverged, so those are never pushed over the local version.
  const cached = await cacheServerRows(accountId, records);
  report.pulled = records.length;
  report.conflictsDetected += cached.conflicted.length;

  const serverById = new Map(records.map((record) => [record.entryId, record]));
  const conflicted = new Set(cached.conflicted);

  const pending = await listPending(accountId);
  for (const change of pending) {
    if (exceededAutomaticAttempts(change.retryCount)) {
      report.waiting += 1;
      report.paused = true;
      continue;
    }
    if (conflicted.has(change.entryId)) continue;
    const serverRecord = serverById.get(change.entryId);
    const serverEntry: ServerEntry = serverRecord
      ? { id: serverRecord.entryId, revision: serverRecord.revision, entry: serverRecord.entry }
      : { id: change.entryId, revision: 0, entry: null };

    if (reconcile(change, serverEntry).kind === 'conflict') {
      await storeConflict({
        accountId,
        entryId: change.entryId,
        local: change,
        server: serverRecord ?? toAccountRecord(accountId, serverEntry),
        detectedAt: now,
      });
      report.conflictsDetected += 1;
      continue;
    }
    try {
      const result = await pushChange(client, accountId, change);
      if (result === 'applied' || result === 'already_applied') report.pushed += 1;
      else report.conflictsDetected += 1;
    } catch (error) {
      // A session change is not a retryable change failure: abort the whole pass
      // rather than recording a retry for work whose identity is no longer valid.
      if (error instanceof SyncIdentityError) throw error;
      const patch = failurePatch(change, error, now);
      const pendingNow = await getPending(accountId, change.entryId);
      if (pendingNow && pendingNow.operationId === change.operationId) {
        await recordFailure(accountId, change.entryId, change.operationId, {
          retryCount: patch.retryCount,
          nextAttemptAt: patch.nextAttemptAt,
          lastError: patch.lastError,
        });
      }
      report.retries += 1;
      report.lastError = patch.lastError;
      report.errorKind = syncErrorKind(error);
      report.paused = exceededAutomaticAttempts(patch.retryCount);
    }
  }
  return report;
}

function failurePatch(change: OutboxRecord, error: unknown, now: string): { retryCount: number; nextAttemptAt: string; lastError: string } {
  const retryCount = (change.retryCount ?? 0) + 1;
  const delay = isRetryable(error) ? nextRetryDelayMillis(retryCount) : 0;
  const message = error instanceof Error ? error.message : 'Sync failed.';
  return { retryCount, nextAttemptAt: new Date(Date.parse(now) + delay).toISOString(), lastError: message };
}

/** Reads the current session for the auth-backed `supabase` client. */
export async function currentSession(supabase: SupabaseClient): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}