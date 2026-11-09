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
Account UI and a project-specific publishable client key are prepared. The Supabase project has an account_entries table with RLS and authenticated per-owner policies; a transactional simulated check confirmed cross-account reads and inserts are denied, while anon SELECT privilege was verified absent. Full two-account end-to-end tests, update/delete isolation tests, local-first sync, migration, and password recovery remain unfinished. The UI does not upload entries. The free built-in SMTP only delivers to project team addresses and is rate-limited; configure custom SMTP before general registration.
