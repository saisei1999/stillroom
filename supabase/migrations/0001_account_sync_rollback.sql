-- Stillroom account sync — ROLLBACK for 0001_account_sync.sql (optional).
--
-- Only run this if 0002_account_sync_verify.sql reports an UNEXPECTED row and you
-- want to return the project to its pre-0001 state. Nothing is dropped that holds
-- user data: no table, no row and no column is removed, so entries that already
-- exist stay exactly where they are. What is removed is the sync engine surface:
--   * both sync RPCs (no client can send or pull changes afterwards),
--   * the applied-operation log (its only purpose is to make retries idempotent;
--     once the RPCs are gone, the log would only grow),
--   * the sync_seq cursor sequence and its unique index,
--   * the constraints and index 0001 added,
--   * the SELECT policy 0001 created (the pre-0001 policies are NOT restored).
-- After this runs the account page can still sign in, and the "account storage
-- connected (N entries)" count still works because authenticated keeps SELECT.
-- Direct client writes stay revoked: 0001 removed them and rollback does not
-- hand them back. Leaving the table read-only is the safe failure direction.
--
-- Not reversible: the revision/tombstone/sync_seq bookkeeping written while 0001
-- was live is forgotten. Re-applying 0001 afterwards is REFUSED by its own
-- column-presence guard — that is deliberate, because re-adding `revision` with
-- a default would reset tombstones to "live revision 1". To re-apply after a
-- rollback you must first export the rows and drop those three columns by hand
-- (or restore from a backup). That is only a problem if push traffic existed; a
-- project that never got past verification has none.
--
-- Run as one paste.

begin;

drop function if exists public.list_account_entries(bigint, integer);
drop function if exists public.apply_entry_change(uuid, uuid, bigint, jsonb, boolean);

drop table if exists public.sync_operations;

-- The cursor sequence is owned by 0001; the RPCs that allocated from it are gone.
drop sequence if exists public.account_entries_sync_seq;

drop policy if exists account_entries_select_own_live on public.account_entries;
-- Restore the pre-0001 policy name, minus the tombstone filter (rollback keeps
-- rows readable; the engine that writes tombstones is gone).
create policy "account_select_own"
  on public.account_entries
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

drop index if exists public.account_entries_owner_sync_seq_idx;

alter table public.account_entries
  drop constraint if exists account_entries_tombstone_payload_check;
alter table public.account_entries
  drop constraint if exists account_entries_sync_seq_check;
alter table public.account_entries
  drop constraint if exists account_entries_revision_check;
alter table public.account_entries
  drop constraint if exists account_entries_payload_size_check;
alter table public.account_entries
  drop constraint if exists account_entries_payload_object_check;
-- Only present if 0001 had to add it (the expected primary key makes it absent).
alter table public.account_entries
  drop constraint if exists account_entries_owner_id_id_key;

-- Keep revision/deleted/sync_seq: dropping them would lose the tombstones the
-- rows already carry, and their defaults keep future inserts valid. Keep RLS
-- enabled. Re-applying 0001 on top of them is refused; see the header.
commit;
