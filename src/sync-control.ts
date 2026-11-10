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
export function setActiveAccount(accountId: string | null): void {
  activeAccountId = accountId;
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
  };
}

export function runSync(accountId: string): Promise<SyncReport> {
  if (!SYNC_ENABLED) return Promise.resolve({ pushed: 0, pulled: 0, conflictsDetected: 0, waiting: 0, retries: 0, lastError: null, errorKind: null, paused: false });
  return runSyncPending(transportOf(buildClient()), accountId);
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
}

/** Resolves a conflict by taking the server's version (an accept). */
export async function resolveConflictUseTheirs(accountId: string, conflict: ConflictRecord): Promise<void> {
  if (conflict.local) await discardChange(accountId, conflict.entryId, conflict.local.operationId);
  if (conflict.server.entry) {
    await acknowledgeChange(accountId, conflict.entryId, conflict.local?.operationId ?? '', conflict.server.revision);
  } else {
    await clearConflict(accountId, conflict.entryId);
  }
}

/** Resolves a diverged conflict by duplicating the local side as a new entry. */
export async function resolveConflictKeepBoth(accountId: string, conflict: ConflictRecord): Promise<void> {
  if (!conflict.local || !conflict.local.entry) return;
  const now = new Date().toISOString();
  const copy = conflictCopyChange(conflict.local, now);
  const copyOp: OutboxRecord = {
    accountId,
    entryId: copy.entryId,
    operationId: copy.operationId,
    expectedRevision: 0,
    entry: copy.entry,
    createdAt: now,
    retryCount: 0,
    nextAttemptAt: now,
    lastError: null,
  };
  await queueAccountSave(accountId, copyOp.entry as Entry, 0);
  // The original conflict remains for the local side; adopt the server revision
  // as the new expectation so the client's own entry syncs without overwriting.
  await replaceQueuedChange(
    { accountId, entryId: conflict.entryId, entry: conflict.local.entry, revision: conflict.server.revision },
    { ...conflict.local, operationId: crypto.randomUUID(), expectedRevision: conflict.server.revision, entry: conflict.local.entry },
  );
  await clearConflict(accountId, conflict.entryId);
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