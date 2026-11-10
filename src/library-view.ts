/**
 * Pure view-model for the library gallery.
 *
 * While sync is disabled (`SYNC_ENABLED === false`) `main.tsx` never loads the
 * account cache and passes a null account id, so `mergeLibraryEntries` returns
 * the local entries untouched: the gallery renders exactly as the local-only
 * build does. Signing in is the only thing that adds account-cached entries.
 *
 * No React and no IndexedDB here: given the local entries and the active
 * account's cached records, this returns the list the gallery should show.
 */
import type { AccountRecord, Entry } from './storage';

/**
 * Merges locally-stored entries with the active account's cached entries.
 *
 * - No active account (signed out): the local entries are returned unchanged,
 *   by reference, preserving today's ordering exactly.
 * - Signed in: local entries plus every account-cached record whose `entry` is
 *   not null, deduplicated by entry id (the account record wins because it is
 *   revision-aware and already holds the pending local version for
 *   account-owned entries), then sorted by `createdAt` descending to match the
 *   existing gallery order.
 * - A tombstone (`entry === null`) is a deletion and never appears. Because the
 *   account record wins dedupe, a tombstone also suppresses a stale local copy
 *   of the same id (for example an entry deleted from another device); local
 *   entries that the account cache does not mention are always kept.
 * - Records whose `accountId` differs from the active account are ignored, so a
 *   late response for a previously signed-in account cannot leak into the view.
 *
 * Neither input is mutated; a new array is returned when signed in.
 */
export function mergeLibraryEntries(
  local: Entry[],
  accountRecords: AccountRecord[],
  activeAccountId: string | null,
): Entry[] {
  if (!activeAccountId) return local;

  const byId = new Map<string, Entry>();
  for (const entry of local) byId.set(entry.id, entry);
  for (const record of accountRecords) {
    // Ignore another account's records: a late response from a previous account
    // must never leak into the current account's gallery.
    if (record.accountId !== activeAccountId) continue;
    // The active account's record wins over any local copy of the same id.
    if (record.entry) byId.set(record.entry.id, record.entry);
    else byId.delete(record.entryId);
  }

  return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
