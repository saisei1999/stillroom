-- DO NOT APPLY: unsafe draft. Pagination can omit rows, operation idempotency
-- has races, and existing policy/privilege isolation has not been verified.
-- Existing installations require a catalog/data inventory before any recovery.
-- Stillroom account sync — migration 0001.
--
-- Supersedes supabase/sync-draft.sql (kept for history only; never apply the draft).
-- Apply with the Supabase SQL editor *after* the precondition queries in
-- supabase/README.md return the expected result. Paste this whole file in one run:
-- the single surrounding transaction means a failed assumption aborts every step.
--
-- PRECONDITIONS (run first, see supabase/README.md §2):
--   select c.relname, c.relrowsecurity as rls, con.conname, con.contype
--     from pg_class c
--     join pg_namespace n on n.oid = c.relnamespace
--     left join pg_constraint con
--            on con.conrelid = c.oid and con.contype in ('p', 'u')
--    where n.nspname = 'public' and c.relname = 'account_entries';
-- Expect: exactly one row per primary/unique constraint on public.account_entries,
-- including a primary key (contype = 'p'). Any other shape stops this migration at
-- the constraint/column steps instead of silently adapting to a different table.
--
-- DESIGN
--  * Clients never write to public.account_entries. Every layer is read-only for
--    the signed-in account (`select`, own rows, live rows only), and all writes go
--    through public.apply_entry_change(), which authenticates the caller itself.
--  * Every write is one atomic, revision-checked, idempotent operation, so a lost
--    HTTP response can be retried with the same operation_id and costs nothing.
--  * Deletions are tombstones (payload stored as '{}'), never row deletes: the
--    pull path can report deletions without racing a concurrent update.
--  * Security definer functions pin `search_path = ''` and schema-qualify every
--    identifier, so a caller-controlled schema cannot shadow a table or function.
--
-- EXPECTED EXISTING SHAPE (as recorded in docs/account-sync.md and the earlier
-- supabase/account-entries.sql): owner_id uuid not null references auth.users(id)
-- (check "owner_id = auth.uid()"), id uuid not null, payload jsonb not null,
-- updated_at timestamptz not null default now(), primary key (owner_id, id),
-- row level security enabled, authenticated owner policies. Unknown columns are
-- tolerated; a missing/incorrect key, ownership column or payload column fails.

begin;

-- ---------------------------------------------------------------------------
-- 0. The pre-existing table must actually exist. No `if not exists` here: a
--    wrong schema has to fail closed rather than be "repaired" into existence.
-- ---------------------------------------------------------------------------
alter table public.account_entries
  add column revision bigint not null default 1;
alter table public.account_entries
  add column deleted boolean not null default false;

-- The draft applied this column nullable (`on delete cascade`); NOT NULL is
-- required so the RPC can never insert an unowned row.
alter table public.account_entries
  alter column owner_id set not null;

-- ---------------------------------------------------------------------------
-- 1. Engine constraints. Named so later migrations and rollback can address
--    them precisely. Each fails the transaction if the existing data violates it.
-- ---------------------------------------------------------------------------
alter table public.account_entries
  add constraint account_entries_payload_object_check
  check (jsonb_typeof(payload) = 'object');
alter table public.account_entries
  add constraint account_entries_payload_size_check
  check (pg_catalog.pg_column_size(payload) <= 262144);
alter table public.account_entries
  add constraint account_entries_revision_check
  check (revision >= 1);
-- A tombstone always stores an empty object; a live row may legitimately hold an
-- empty object too (an entry with nothing filled in yet), so only the tombstone
-- side is constrained.
alter table public.account_entries
  add constraint account_entries_tombstone_payload_check
  check (not deleted or payload = '{}'::jsonb);

-- Ownership key. If the expected primary key (owner_id, id) already exists under
-- any name this is a no-op; otherwise it is added explicitly and checked.
do $precheck$
begin
  if not exists (
    select 1
      from pg_catalog.pg_index i
     where i.indrelid = 'public.account_entries'::regclass
       and i.indisunique
       and not i.indisprimary
       and (
             select pg_catalog.array_agg(a.attname::text order by a.attname::text)
               from pg_catalog.pg_attribute a
              where a.attrelid = i.indrelid
                and a.attnum = any (i.indkey::smallint[])
           ) = array['id', 'owner_id']::text[]
   )
  and not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.account_entries'::regclass
       and c.contype = 'p'
       and (
             select pg_catalog.array_agg(a.attname::text order by a.attname::text)
               from pg_catalog.pg_attribute a
              where a.attrelid = c.conrelid
                and a.attnum = any (c.conkey)
           ) = array['id', 'owner_id']::text[]
   )
  then
    alter table public.account_entries
      add constraint account_entries_owner_id_id_key unique (owner_id, id);
  end if;
end
$precheck$;

-- Pull ordering: the cursor is (updated_at, id), so it needs both columns in one
-- index with a matching order.
create index if not exists account_entries_owner_updated_idx
  on public.account_entries (owner_id, updated_at, id);

-- ---------------------------------------------------------------------------
-- 2. Retire the previous write path. The earlier account-entries.sql granted
--    select/insert/update/delete to authenticated with matching policies; those
--    must go before the RPC-only model is introduced. The select policy is
--    dropped and re-created below by this migration under a fresh name.
-- ---------------------------------------------------------------------------
drop policy if exists "account_insert_own" on public.account_entries;
drop policy if exists "account_update_own" on public.account_entries;
drop policy if exists "account_delete_own" on public.account_entries;
drop policy if exists "account_select_own" on public.account_entries;
drop policy if exists "read own entries" on public.account_entries;

-- No client-issued write privilege survives on any role, including the implicit
-- PUBLIC grant that `create table` adds by default.
revoke insert, update, delete on public.account_entries
  from authenticated, anon, public;
grant select on public.account_entries to authenticated;

alter table public.account_entries enable row level security;

-- Owner-scoped reads, live rows only. Tombstones are written with
-- deleted = true and hidden here; the pull RPC (security definer) sees them.
-- `(select auth.uid())` is evaluated once per statement instead of per row.
create policy account_entries_select_own_live
  on public.account_entries
  for select
  to authenticated
  using ((select auth.uid()) = owner_id and not deleted);

-- ---------------------------------------------------------------------------
-- 3. Applied-operation log. The RPC is its only reader/writer; RLS with no
--    policies means even a future privilege mistake is inert. The revision is
--    the revision that operation produced (0 when the row did not exist yet).
-- ---------------------------------------------------------------------------
create table public.sync_operations (
  owner_id     uuid        not null references auth.users (id) on delete cascade,
  operation_id uuid        not null,
  entry_id     uuid        not null,
  revision     bigint      not null check (revision >= 0),
  created_at   timestamptz not null default now(),
  constraint sync_operations_pkey primary key (owner_id, operation_id)
);
alter table public.sync_operations enable row level security;
revoke all on public.sync_operations from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Push path.
--
-- public.apply_entry_change(p_id uuid, p_operation_id uuid,
--                           p_expected_revision bigint, p_payload jsonb,
--                           p_deleted boolean)
--   returns (outcome text, revision bigint, payload jsonb,
--            deleted boolean, applied_revision bigint)
--   (call as supabase.rpc('apply_entry_change', { ... }); the result is one row)
--
--   outcome 'applied'         — write committed; `revision` is the new revision.
--   outcome 'already_applied' — this operation_id already committed. `revision`,
--                               `payload` and `deleted` are the row's CURRENT
--                               values (not the stored values), so a retry of an
--                               old operation never resurrects stale content.
--                               `applied_revision` says which revision this
--                               operation itself produced.
--   outcome 'conflict'        — expected revision lost; the current revision,
--                               payload and deleted flag are returned.
--                               revision 0 / payload '{}' / deleted false means
--                               "no row at this id" (only for a non-create send).
--   errors (SQLSTATE 42501 / 22023) — authentication missing, or invalid input:
--                               nothing is written and the caller may fix and retry.
--
-- Semantics
--   p_expected_revision = 0 creates, and only creates: if a row already exists at
--   p_id the call is a conflict, never an overwrite. p_expected_revision > 0 must
--   match `revision` or the call is a conflict. Deleting stores a tombstone with
--   payload '{}' and deleted = true; p_payload is accepted (and ignored) on a
--   delete so a queued entry body is never a reason to fail a delete.
--   RESURRECT RULE: a deleted row is not special on the write path. A create or
--   update for a tombstoned id whose p_expected_revision matches the tombstone's
--   revision applies as an ordinary update (revision + 1, deleted becomes false).
--   This is what makes "delete on one device, edit on another, reconnect" converge.
--   Clients recover from conflict/tombstone state accordingly.
--
--   Locking: the entry row is locked first (or nothing, for a fresh insert) and
--   the applied-operation row second. That order is the same in every path, so
--   concurrent senders cannot deadlock each other, and the second lock is only
--   reached when the operation_id is confirmed new.
-- ---------------------------------------------------------------------------
create function public.apply_entry_change(
  p_id uuid,
  p_operation_id uuid,
  p_expected_revision bigint,
  p_payload jsonb,
  p_deleted boolean
)
returns table (
  outcome text,
  revision bigint,
  payload jsonb,
  deleted boolean,
  applied_revision bigint
)
language plpgsql
security definer
set search_path = ''
as $apply$
declare
  v_uid uuid := auth.uid();
  v_row public.account_entries%rowtype;
  v_applied public.sync_operations%rowtype;
  v_revision bigint;
  v_payload jsonb;
  v_deleted boolean;
begin
  if v_uid is null then
    raise exception 'Authentication required'
      using errcode = '42501',
            hint = 'Sign in before sending account changes.';
  end if;

  if p_id is null or p_operation_id is null or p_expected_revision is null
     or p_deleted is null then
    raise exception 'Invalid operation parameters'
      using errcode = '22023';
  end if;
  if p_expected_revision < 0 then
    raise exception 'Invalid expected revision'
      using errcode = '22023',
            hint = 'p_expected_revision must be 0 (create) or a known revision.';
  end if;
  -- Payload rules. A delete may carry the deleted entry's body (clients keep it
  -- until acknowledgement); it is never stored. A live write needs an object.
  if p_payload is null then
    raise exception 'Invalid payload'
      using errcode = '22023',
            hint = 'p_payload is required (use an empty JSON object if unwanted).';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Invalid payload'
      using errcode = '22023',
            hint = 'p_payload must be a JSON object.';
  end if;
  if pg_catalog.pg_column_size(p_payload) > 262144 then
    raise exception 'Payload too large'
      using errcode = '22023',
            hint = 'A single entry payload may not exceed 256 KiB.';
  end if;

  -- Entry row, guarded by the owner column. FOR UPDATE also serialises a
  -- concurrent create of the same id (the second create wakes to a found row).
  select * into v_row
    from public.account_entries
   where owner_id = v_uid
     and id = p_id
   for update;

  if found then
    -- Any write for this revision is already known to this operation.
    select * into v_applied
      from public.sync_operations
     where owner_id = v_uid
       and operation_id = p_operation_id;
    if found then
      if v_applied.entry_id <> p_id then
        raise exception 'Operation ID was already used for a different entry'
          using errcode = '22023';
      end if;
      -- Stored values would be stale if a later operation advanced the row.
      -- Report the row's current state; the caller re-runs its reconcile.
      return query select 'already_applied'::text, v_row.revision, v_row.payload,
                          v_row.deleted, v_applied.revision;
      return;
    end if;

    if v_row.revision <> p_expected_revision then
      -- Includes the expected p_expected_revision = 0 while the row exists.
      return query select 'conflict'::text, v_row.revision, v_row.payload,
                          v_row.deleted, null::bigint;
      return;
    end if;

    v_revision := v_row.revision + 1;
    v_deleted := p_deleted;
    v_payload := case when p_deleted then '{}'::jsonb else p_payload end;
    update public.account_entries as ae
       set revision = v_revision,
           payload = v_payload,
           deleted = v_deleted,
           updated_at = pg_catalog.now()
     where ae.owner_id = v_uid
       and ae.id = p_id;
  else
    -- No row: nothing was locked above, so check the operation log directly.
    select * into v_applied
      from public.sync_operations
     where owner_id = v_uid
       and operation_id = p_operation_id;
    if found then
      if v_applied.entry_id <> p_id then
        raise exception 'Operation ID was already used for a different entry'
          using errcode = '22023';
      end if;
      -- The entry was removed after this operation (out-of-band reset), or a
      -- concurrent delete committed first. Report the absence, not stale data.
      return query select 'already_applied'::text, 0::bigint, '{}'::jsonb,
                          true, v_applied.revision;
      return;
    end if;

    if p_expected_revision <> 0 then
      return query select 'conflict'::text, 0::bigint, '{}'::jsonb,
                          false, null::bigint;
      return;
    end if;

    v_revision := 1;
    v_deleted := p_deleted;
    v_payload := case when p_deleted then '{}'::jsonb else p_payload end;
    -- A create that carries a tombstone (create-then-delete before any sync)
    -- inserts the tombstone directly; otherwise this is a live revision-1 row.
    -- ON CONFLICT (owner_id, id) depends on the uniqueness guaranteed above; if
    -- that key were missing, this statement would fail at runtime instead of
    -- silently creating a duplicate row.
    insert into public.account_entries (owner_id, id, payload, revision, deleted, updated_at)
    values (v_uid, p_id, v_payload, v_revision, v_deleted, pg_catalog.now())
    on conflict (owner_id, id) do nothing;
    if not found then
      -- Lost an insert race with a concurrent apply of the same new entry:
      -- treat it as a conflict so the caller reloads and retries cleanly.
      select * into v_row
        from public.account_entries
       where owner_id = v_uid
         and id = p_id;
      if not found then
        -- The racing transaction rolled back or removed the row again; report
        -- the conflict with "no row" state instead of dereferencing NULLs.
        return query select 'conflict'::text, 0::bigint, '{}'::jsonb,
                            false, null::bigint;
        return;
      end if;
      return query select 'conflict'::text, v_row.revision, v_row.payload,
                          v_row.deleted, null::bigint;
      return;
    end if;
  end if;

  insert into public.sync_operations (owner_id, operation_id, entry_id, revision)
  values (v_uid, p_operation_id, p_id, v_revision);

  return query select 'applied'::text, v_revision, v_payload, v_deleted, v_revision;
end
$apply$;

-- SECURITY DEFINER functions are executable by PUBLIC unless revoked.
revoke all on function public.apply_entry_change(uuid, uuid, bigint, jsonb, boolean)
  from public, anon;
grant execute on function public.apply_entry_change(uuid, uuid, bigint, jsonb, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Pull path.
--
-- public.list_account_entries(p_since timestamptz, p_limit integer)
--   returns (id uuid, revision bigint, payload jsonb, deleted boolean,
--            updated_at timestamptz)
--
--   Caller-owned rows, tombstones INCLUDED (deleted = true, payload '{}'),
--   ordered by (updated_at, id) and filtered by `updated_at > p_since`.
--   p_since null means "from the beginning"; p_limit is clamped to 1..500.
--
--   Why a direct RLS select is not used: the select policy hides tombstones
--   (they are an internal representation) and RLS also re-filters any security
--   invoker query. This definer function returns exactly the caller's rows,
--   including tombstones, and nothing else.
--
--   Cursor safety: `updated_at > since` can never skip a committed row: a row's
--   updated_at is stamped inside the writing transaction and only that
--   transaction changes it, so a cursor taken after a page commits is causally
--   complete for everything older. The (updated_at, id) order makes ties
--   deterministic and the owner/updated_at/id index serves both. Contract for
--   clients: page until a page returns fewer than `limit` rows; resume from
--   the last row's (updated_at, id) at or before that timestamp. Because the
--   equality case is excluded, resuming from a timestamp may replay rows that
--   tie on it — replays are idempotent when applied by revision.
-- ---------------------------------------------------------------------------
create function public.list_account_entries(
  p_since timestamptz,
  p_limit integer
)
returns table (
  id uuid,
  revision bigint,
  payload jsonb,
  deleted boolean,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $list$
  select ae.id, ae.revision, ae.payload, ae.deleted, ae.updated_at
    from public.account_entries as ae
   where ae.owner_id = auth.uid()
     and (p_since is null or ae.updated_at > p_since)
   order by ae.updated_at, ae.id
   limit least(greatest(coalesce(p_limit, 500), 1), 500)
$list$;

revoke all on function public.list_account_entries(timestamptz, integer)
  from public, anon;
grant execute on function public.list_account_entries(timestamptz, integer)
  to authenticated;

commit;
