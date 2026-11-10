/**
 * Sync controller: composes the durable outbox, the account cache (storage.ts),
 * the pure decision logic (sync-core.ts) and the Supabase transport
 * (account-sync.ts) behind a single runtime flag. React components read state
 * from here and call these actions; no component reaches into IndexedDB directly.
 *
 * Everything here is guarded by `SYNC_ENABLED`. Until the live migration is
 * verified against two real accounts, the flag stays `false` and the app behaves
 * exactly like the local-only build: no network RPC, no outbox writes.
 */

import {
  createAccountClient,
} from './account-client';
import type { SupabaseClient, Session } from '@supabase/supabase-js';
import {
  listAccountEntries,
  listPending,
  listConflicts,
  getAccountEntry,
  getPending,
  queueAccountChange,
  replaceQueuedChange,
  acknowledgeChange,
  discardChange,
  storeConflict,
  clearConflict,
  acceptServerRow,
  stageLocalImport,
  revertStagedImport,
  clearAccountCache,
  markAccountCached,
  listCachedAccounts,
  putBackup,
  deleteBackup,
  listBackups,
  putMutation,
  deleteMutation,
  listMutations,
  getMeta,
  putMeta,
  type AccountRecord,
  type OutboxRecord,
  type ConflictRecord,
  type Entry,
} from './storage';
import {
  syncPending as runSyncPending,
  currentSession,
  type SyncReport,
  type TransportClient,
} from './account-sync';
import {
  friendlySyncError,
  syncErrorKind,
  planImport,
  conflictCopyChange,
  pendingForConflict,
  createChangeFor,
  exceededAutomaticAttempts,
  type ConflictKind,
} from './sync-core';

/** Flip to `true` ONLY after migration 0001+0002 pass and the two-account gate is green. */
export const SYNC_ENABLED = false;

// The currently signed-in account id, kept in sync by AccountPanel so main.tsx's
// save/delete handlers can route account-owned edits through the durable outbox
// without threading session state through the whole App component.
let activeAccountId: string | null = null;
type ActiveAccountListener = (accountId: string | null) => void;
const activeAccountListeners = new Set<ActiveAccountListener>();

/** Notifies `listener` when the signed-in account changes; returns an unsubscribe. */
export function subscribeActiveAccount(listener: ActiveAccountListener): () => void {
  activeAccountListeners.add(listener);
  return () => {
    activeAccountListeners.delete(listener);
  };
}

export function setActiveAccount(accountId: string | null): void {
  if (accountId === activeAccountId) return;
  activeAccountId = accountId;
  // Copy before notifying: a listener may unsubscribe while we iterate.
  for (const listener of Array.from(activeAccountListeners)) {
    try {
      listener(accountId);
    } catch {
      // A broken listener must not stop the others or the auth flow.
    }
  }
}
export function getActiveAccount(): string | null {
  return activeAccountId || null;
}

const PROJECT_URL = 'https://hmrmcpsrzrhwquyxdfta.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_FHbJZbLEkfdSI4ZDURFUjg_SjTTEbyB';

// Lazily-created client is fine: `createAccountClient` only validates then hands
// back a SupabaseClient. We never embed a secret.
function buildClient(): SupabaseClient {
  return createAccountClient(PROJECT_URL, PUBLISHABLE_KEY);
}

export type SyncUiState = {
  session: Session | null;
  accountId: string | null;
  syncEnabled: boolean;
  initialized: boolean;
};

export type ImportChoice = { staged: number; skipped: number } | null;

/** Pulls the current session and the account it maps to (empty when signed out). */
export function readSessionState(): Promise<SyncUiState> {
  if (!SYNC_ENABLED) {
    return Promise.resolve({ session: null, accountId: null, syncEnabled: false, initialized: true });
  }
  return currentSession(buildClient()).then((session) => ({
    session,
    accountId: session ? String(session.user.id) : null,
    syncEnabled: true,
    initialized: true,
  }));
}

/** The transport view of the Supabase client (matches `TransportClient`). */
function transportOf(client: SupabaseClient): TransportClient {
  return {
    rpc: (fn, args) =>
      client.rpc(fn, args).then((result) => ({ data: (result as { data: unknown }).data ?? null, error: (result as { error: unknown }).error ?? null })) as Promise<{ data: null; error: unknown }>,
    // Read the live session, never the caller-supplied accountId: sync verifies
    // this still matches before every pull/push and after each await.
    currentUserId: () =>
      client.auth.getSession().then(({ data }) => data.session?.user?.id ?? null),
  };
}

/**
 * Tells subscribed views to re-read the account cache. A pull can add, change or
 * tombstone entries while the app is open, so the gallery must be told to refresh
 * — otherwise downloaded entries would not appear until the next account change.
 */
export function notifyAccountDataChanged(): void {
  const accountId = activeAccountId;
  for (const listener of Array.from(activeAccountListeners)) {
    try {
      listener(accountId);
    } catch {
      // A broken listener must not stop the others.
    }
  }
}

export function runSync(accountId: string): Promise<SyncReport> {
  if (!SYNC_ENABLED) return Promise.resolve({ pushed: 0, pulled: 0, conflictsDetected: 0, waiting: 0, retries: 0, lastError: null, errorKind: null, paused: false });
  return runSyncPending(transportOf(buildClient()), accountId).then(
    (report) => {
      // The cache may have gained rows or conflicts; let the view catch up.
      notifyAccountDataChanged();
      return report;
    },
    (error) => {
      // Even a partially-completed pass can have cached rows; refresh, then rethrow.
      notifyAccountDataChanged();
      throw error;
    },
  );
}

/** Whether a local edit should be routed through the account outbox. */
export async function accountOwns(accountId: string, entryId: string): Promise<boolean> {
  if (!SYNC_ENABLED || !accountId) return false;
  const record = await getAccountEntry(accountId, entryId);
  return !!record;
}

/** One-shot save/delete routing for main.tsx. Returns false when unsynced-local only. */
export async function routeLocalMutation(entryId: string, mode: 'save' | 'delete', entry: Entry | null): Promise<boolean> {
  if (!SYNC_ENABLED) return false;
  const accountId = getActiveAccount();
  if (!accountId) return false;
  if (!(await accountOwns(accountId, entryId))) return false;
  if (mode === 'delete') await queueAccountDelete(accountId, entryId);
  else if (entry) {
    const record = await getAccountEntry(accountId, entryId);
    const expectedRevision = record?.revision ?? 0;
    await queueAccountSave(accountId, entry, expectedRevision);
  }
  return true;
}

/**
 * Saves an account-owned entry through the durable outbox. The local store write
 * and the outbox write are separate here; callers already wrote locally. This
 * keeps the account cache and outbox in lock-step with the acknowledged revision.
 */
export async function queueAccountSave(accountId: string, entry: Entry, expectedRevision: number): Promise<void> {
  const record: AccountRecord = { accountId, entryId: entry.id, entry, revision: expectedRevision };
  const pending = await getPending(accountId, entry.id);
  const createdAt = pending?.createdAt ?? new Date().toISOString();
  const operation: OutboxRecord = {
    accountId,
    entryId: entry.id,
    // A replacement can race an in-flight request and needs its own identity.
    operationId: crypto.randomUUID(),
    expectedRevision,
    entry,
    createdAt,
    retryCount: 0,
    nextAttemptAt: new Date().toISOString(),
    lastError: null,
  };
  if (pending) await replaceQueuedChange(record, operation);
  else await queueAccountChange(record, operation);
}

/** Queues a deletion tombstone for an account-owned entry. */
export async function queueAccountDelete(accountId: string, entryId: string): Promise<void> {
  const pending = await getPending(accountId, entryId);
  const record = await getAccountEntry(accountId, entryId);
  const expectedRevision = record?.revision ?? pending?.expectedRevision ?? 0;
  const op: OutboxRecord = {
    accountId,
    entryId,
    operationId: crypto.randomUUID(),
    expectedRevision,
    entry: null,
    createdAt: pending?.createdAt ?? new Date().toISOString(),
    retryCount: 0,
    nextAttemptAt: new Date().toISOString(),
    lastError: null,
  };
  if (pending) await replaceQueuedChange({ accountId, entryId, entry: null, revision: expectedRevision }, op);
  else await queueAccountChange({ accountId, entryId, entry: null, revision: expectedRevision }, op);
}

export type ConflictView = {
  record: ConflictRecord;
  kind: ConflictKind;
  localPreview: string;
  serverPreview: string;
};

export function conflictPreview(record: ConflictRecord): ConflictView {
  const kind: ConflictKind = !record.local ? (record.server.entry ? 'edited-remotely' : 'deleted-remotely') : record.local.entry === null ? 'deleted-locally' : record.server.entry === null ? 'deleted-remotely' : 'diverged';
  const localPreview = record.local?.entry ? `${record.local.entry.title} (edited here)` : 'Deleted on this device';
  const serverPreview = record.server.entry ? `${record.server.entry.title} (edited in your account)` : 'Deleted in your account';
  return { record, kind, localPreview, serverPreview };
}

function toOutbox(op: ReturnType<typeof pendingForConflict>): OutboxRecord {
  return { ...op, createdAt: op.createdAt, retryCount: 0, nextAttemptAt: op.createdAt, lastError: null };
}

/** Resolves a conflict by keeping this device's version (a push). */
export async function resolveConflictKeepMine(accountId: string, conflict: ConflictRecord): Promise<void> {
  if (!conflict.local) return;
  const op = toOutbox(pendingForConflict({ local: conflict.local, server: { id: conflict.entryId, revision: conflict.server.revision, entry: conflict.server.entry } }, conflict.local.entry));
  await replaceQueuedChange({ accountId, entryId: conflict.entryId, entry: conflict.local.entry, revision: conflict.server.revision }, op);
  await clearConflict(accountId, conflict.entryId);
  notifyAccountDataChanged();
}

/**
 * Resolves a conflict by taking the server's version for the original entry.
 * Drops the local queued change and adopts the server row (including a server
 * deletion, which is stored as a tombstone) in one atomic step, then clears the
 * conflict marker. The previous version discarded the local change and then
 * called `acknowledgeChange`, which found no pending operation and therefore
 * never adopted the server row and never cleared the conflict.
 */
export async function resolveConflictUseTheirs(accountId: string, conflict: ConflictRecord): Promise<void> {
  await acceptServerRow(accountId, {
    accountId,
    entryId: conflict.entryId,
    entry: conflict.server.entry,
    revision: conflict.server.revision,
  });
  notifyAccountDataChanged();
}

/**
 * Resolves a diverged conflict by keeping BOTH sides:
 * - the local version is preserved as a NEW entry (fresh id) and queued as a create, and
 * - the ORIGINAL id keeps the server's version.
 *
 * The previous version instead re-queued the local content against the original id
 * at the server revision, so the next push overwrote the server copy — not "both".
 */
export async function resolveConflictKeepBoth(accountId: string, conflict: ConflictRecord): Promise<void> {
  if (!conflict.local || !conflict.local.entry) return;
  const now = new Date().toISOString();
  const copy = conflictCopyChange(conflict.local, now);
  // 1. Preserve the local edit as a brand-new entry (its own create operation).
  await queueAccountSave(accountId, copy.entry as Entry, 0);
  // 2. The original entry keeps the server's version; the local edit no longer
  //    targets it, so it can never be pushed over the server copy.
  await acceptServerRow(accountId, {
    accountId,
    entryId: conflict.entryId,
    entry: conflict.server.entry,
    revision: conflict.server.revision,
  });
  notifyAccountDataChanged();
}

export { markAccountCached, listCachedAccounts, stageLocalImport, revertStagedImport, clearAccountCache, listConflicts, listPending, listAccountEntries, getMeta, putMeta, putBackup, deleteBackup, listBackups, putMutation, deleteMutation, listMutations };

/** Friendly, honest summary for the active account. */
export function summarizeSync(report: SyncReport, pending: OutboxRecord[], conflicts: ConflictRecord[]): string {
  void report;
  const pendingCount = pending.length;
  const conflictCount = conflicts.length;
  if (pendingCount === 0 && conflictCount === 0) return 'Synced · nothing waiting';
  if (conflictCount > 0) return `${conflictCount} ${conflictCount === 1 ? 'conflict needs' : 'conflicts need'} your review`;
  return `${pendingCount} ${pendingCount === 1 ? 'change' : 'changes'} waiting to sync`;
}

export function isWaiting(report: SyncReport): boolean {
  return report.retries > 0 || report.waiting > 0;
}