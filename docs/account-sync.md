# Account sync implementation plan (not yet enabled)

## Product decisions
Email/password sign-in with Supabase Auth; existing GitHub Pages static host remains. Entries stay locally available offline and are associated with one account only after an explicit migration choice. Never silently overwrite or upload a local library. Users can continue locally signed out. Supabase free projects can pause; communicate offline and retry state and retain pending writes. Browser storage remains vulnerable to eviction/clearing; JSON backup remains available.

## Security gates
Use the public project URL and publishable key only, never a secret/service-role key in client or Git. Per-user row-level security must be verified with two distinct accounts for reads, writes, deletion and RPC access. The checked-in SQL is intentionally disabled and is not production-ready. Validate payload shape and size server-side. Enable email verification and configure allowed redirects for the actual Pages origin. Avoid exposing user emails in shared public content. Supabase's free email service and rate limits must be reviewed for intended usage.

## Data integrity design
- Upgrade IndexedDB via explicit migration; preserve existing entries and backup before changes. Partition cached entries, pending operations, and sync metadata by account; never show one account's private cache to another.
- Durable outbox: local entry update and queued operation must commit in one IndexedDB transaction; do not mark synced until the server acknowledges. Include stable operation IDs for idempotency, entry IDs, expected server revision and deletion tombstones. Retry on reconnect and app reopen, with backoff and visible errors. Do not silently lose pending work on sign-out.
- Server applies writes atomically only when expected revision matches, assigns new revision, validates ownership, and stores tombstones. Use server ordering/cursors that cannot skip concurrent writes; handle pagination and interrupted pulls safely.
- For conflicts preserve both local and server versions, show the user what changed, and ask which to keep or provide both as copies; never silently apply last-write-wins. Test edits and deletes on two offline devices, reordered responses, crashes between transaction steps, retries, and account switches.
- First sign-in: show counts and an explicit choice to merge local entries into the account or keep them local; detect same ID with differing contents as a conflict. A second device downloads the account library without replacing unrelated local entries. Keep pre-migration export/restore available.
- Privacy: local caching of account data is visible to anyone with access to the same browser profile; document sign-out behavior and provide an explicit local-cache removal option only after pending operations are safe.

## Acceptance gates
1. Real two-account authorization tests prove isolation and reject anonymous access and guessed IDs.
2. Two browser profiles: create/edit/delete on A, sync to B; offline edit on B, reconnect and sync; explicit conflict handling and deletion tombstones survive retries/reloads.
3. Existing local data survives migration and failed writes. Switching accounts and signing out never mixes or discards data.
4. Restore/backup behavior is defined for signed-in users and cannot silently replace synced data. Test duplicate IDs, invalid files, failed storage and aborted transactions.
5. Offline and paused service show pending changes, never a false synced state. Credentials are not committed; redirects and email confirmation tested on the deployed URL.

Do not wire the draft schema or display a working sync option until these gates pass. Current app remains local-only.

## Current status: built, still disabled, not yet safe to enable
Sync remains disabled (`SYNC_ENABLED = false` in `src/sync-control.ts`), so the
shipped app is still the local-only build and makes no network RPC calls.

Verified in this repo: `npm test` passes (143 tests) and `npm run build` succeeds.

### Fixed after review
- **Pull could skip rows.** The timestamp cursor (`updated_at > p_since`) could
  permanently drop rows sharing a timestamp. Replaced with a `sync_seq` bigint
  allocated in commit order under a per-owner advisory lock; the client resumes
  strictly above it and fails closed if a pulled row has no sequence.
- **RPC result shape.** `apply_entry_change` returns a table, so PostgREST sends a
  one-element array; the client treated it as an object and would never have
  acknowledged a real push. It now validates exactly one row.
- **Pull overwrote unacknowledged local edits.** `cacheServerRows` now keeps the
  pending local version and records a conflict instead of clobbering it.
- **Operation-ID reuse.** Queued saves/deletes and keep-both mint fresh operation
  ids, and the migration binds an operation id to its request content, so a
  changed payload can no longer masquerade as an already-applied operation.
- **Account-identity race.** The transport now verifies the *authenticated*
  identity before and after every network step, so a session change mid-sync
  aborts rather than caching or pushing against the wrong account.
- **Conflict resolution was wrong.** "Use theirs" now adopts the server row
  (including a server deletion) and clears the conflict; "keep both" preserves the
  local version as a new entry while the original id keeps the server version.
- **Migration preflight.** A read-only `0000_preflight.sql` inventories policies,
  privileges, indexes and constraints and fails closed; it refuses to run if
  `revision`/`deleted`/`sync_seq` already exist, so prior tombstone state cannot
  be silently reset.

### Still required before enabling
1. **Supabase production is still unverified.** The SQL has now been *executed
   locally against a real PostgreSQL engine* (PGlite/WASM) via
   `supabase/verify/pg-local-verify.mjs` — 28/28 checks, covering preflight,
   `0001` applying, the `0002` audit, create/update/conflict/idempotency,
   tombstones and resurrection, skip-free `sync_seq` paging across tied
   timestamps, anon denial, cross-account isolation, and the rollback. That is
   strong evidence about the SQL, but there is still no GoTrue, no PostgREST and
   no Supabase-managed roles locally, so the hosted project must be exercised
   once (preflight, then `0001`, then `0002`).
2. **The live two-account gate has not passed.** Run
   `supabase/verify/authorization.mjs` against the hosted project after applying
   the migration. A missing function returning 404 is not an authorization pass.
3. `currentUserId` reads the locally stored session rather than server-verifying
   the token on every check; an already-sent request cannot be retracted.
4. Real-browser IndexedDB and two real browser profiles remain untested; the
   two-device convergence test (`tests/two-device-sync.test.ts`) covers the
   logic against a server model, not a real network.

### Fixed while verifying the SQL locally
`supabase/verify/authorization.mjs` asserted that account B calling
`apply_entry_change` for account A's entry id with `p_expected_revision = 0`
must return `conflict`. It does not: ids are unique per **owner**, so B
legitimately creates its *own* row under that uuid while A's row is untouched.
The check now proves the real security property — A's row is unchanged.

### Library view
`src/library-view.ts` merges the local library with the active account's cached
entries (tombstones hidden, account record wins on the same id), and
`subscribeActiveAccount` / `notifyAccountDataChanged` refresh the gallery when the
account changes or a pull/conflict resolution updates the cache. While
`SYNC_ENABLED` is false the merge is skipped entirely, so the rendered list is
identical to the local-only build.

### Note on the earlier cleanup
An earlier instruction in this session told the user to drop the `revision` and
`deleted` columns and the `sync_operations` table. That advice was wrong and has
been removed. A read-only check of the live project shows both test accounts have
zero rows and no successful sync write ever occurred, so nothing was lost — but
the instruction should never have been given. Do not drop those columns.

