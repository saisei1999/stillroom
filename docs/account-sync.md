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

## Current status
A complete local-first sync implementation is now built and tested behind a
runtime flag. Accounts sign in with email/password; `entryPayloadSize` and RLS
guard payload sizes; the durable outbox, account-partitioned caches, revision
checks, conflict preservation and explicit conflict resolution are implemented
and covered by fixture tests. Sync is **not enabled**: `SYNC_ENABLED` in
`src/sync-control.ts` is `false`, so the shipped app behaves exactly as the
local-only build does until the live gate below passes.

Live verification still pending: apply `migrations/0001_account_sync.sql`, run
the `0002` audit, and pass `supabase/verify/authorization.mjs` against two
confirmed accounts before flipping the flag. Until then the app makes no network
RPC calls and queues no outbox writes.

## How the pieces fit (for reviewers)
- `src/sync-core.ts` — pure domain decisions (reconcile, retry schedule,
  validation, conflict classification, import planning, conflict-copy).
- `src/storage.ts` — IndexedDB v3 with account-partitioned caches and a durable,
  revision-checked outbox written atomically with local changes.
- `src/account-sync.ts` — the transport that consumes `apply_entry_change` and
  `list_account_entries`, validates every server row, and never acknowledges a
  change until the server does.
- `src/sync-control.ts` — the tested controller tying UI to storage + transport,
  behind `SYNC_ENABLED`.
- `src/AccountPanel.tsx` / `src/main.tsx` — sign-in, import choice, honest sync
  status, conflict resolution, cache removal, and gated save/delete routing.
- `supabase/migrations/0001_account_sync.sql` — the reviewed migration (client
  loses all write grants; writes only via the revision-checked, idempotent,
  `search_path=''` security-definer RPC; tombstones; cursor pull).

## Server schema (migration written, not yet applied)
`supabase/migrations/0001_account_sync.sql` supersedes the handoff draft and is the only file to apply; `0002_account_sync_verify.sql` is a read-only audit; `0001_account_sync_rollback.sql` reverses it without deleting user data. Step-by-step instructions and the precondition queries (the existing table's key/columns are still unconfirmed) are in `supabase/README.md`.

Design as written: `account_entries` gains `revision`/`deleted`, named checks and a pull index, and the client loses every write privilege — `authenticated` keeps only owner-scoped `select` of live rows. Writes go through `apply_entry_change(p_id, p_operation_id, p_expected_revision, p_payload, p_deleted)`, which returns `(outcome, revision, payload, deleted, applied_revision)` with outcome `applied`, `already_applied` or `conflict`; tombstones are stored as `{}` and revive as ordinary updates. Pulls use `list_account_entries(p_since, p_limit)`, which returns the caller's rows including tombstones in `(updated_at, id)` order, limit clamped to 1..500. Both are `security definer set search_path = ''`, executable only by `authenticated`.

What is verified today: static migration checks in `tests/rls-fixtures.test.ts` (text analysis only — they cannot prove SQL parses or that RLS denies anything). Still open before sync may ship: applying 0001 in the dashboard, running the 0002 audit, and passing `supabase/verify/authorization.mjs` against two confirmed accounts. The RPC contract is not yet consumed by any client code.
