-- Stillroom account sync — migration 0001.
--
-- STATUS: this revision has NOT been applied to any project and has NOT been
-- executed against a live PostgreSQL server. Apply it only after
-- supabase/migrations/0000_preflight.sql reports PREFLIGHT OK and the lead
-- approves. It replaces an earlier draft that could skip rows, race its own
-- idempotency check and damage existing isolation; that draft must never be run.
--
-- Supersedes supabase/sync-draft.sql and supabase/schema-draft.sql (history
-- only; never apply either draft).
--
-- Run 0000_preflight.sql first, then paste this whole file in ONE run: the single
-- surrounding transaction means a failed assumption aborts every step.
--
-- DESIGN
--  * Clients never write to public.account_entries. Every layer is read-only for
--    the signed-in account (select, own rows, live rows only), and all writes go
--    through public.apply_entry_change(), which authenticates the caller itself.
--  * Every write is one atomic, revision-checked, idempotent operation, so a lost
--    HTTP response can be retried with the same operation_id and costs nothing.
--  * Deletions are tombstones (payload stored as '{}'), never row deletes: the
--    pull path can report deletions without racing a concurrent update.
--  * The pull cursor is a monotonic bigint (sync_seq), never a timestamp; see
--    section 5 for the skip-safety argument.
--  * Security definer functions pin `search_path = ''` and schema-qualify every
--    identifier, so a caller-controlled schema cannot shadow a table or function.
--
-- EXPECTED EXISTING SHAPE (verified by 0000_preflight.sql): owner_id uuid not
-- null references auth.users(id), id uuid not null, payload jsonb not null,
-- updated_at timestamptz not null default now(), a valid non-partial unique key
-- on (owner_id, id) (or no duplicates so this migration can add it), RLS enabled,
-- and NO revision/deleted/sync_seq columns and NO sync functions/tables.

begin;

-- ---------------------------------------------------------------------------
-- 0. The pre-existing table must actually exist. No `if not exists` here: a
--    wrong schema has to fail closed rather than be "repaired" into existence.
--
--    Column-presence guard: revision/deleted/sync_seq must be absent. The ALTERs
--    below are intentionally unconditional (an existing column makes them fail).
--    That is the fail-closed behaviour we want: this migration will NOT reset a
--    prior attempt's revision/tombstone state to defaults. If a previous attempt
--    left those columns behind, stop and reconcile by hand (see 0000_preflight).
-- ---------------------------------------------------------------------------
do $columns$
declare
  v_existing text;
begin
  select pg_catalog.string_agg(a.attname, ', ' order by a.attname)
    into v_existing
    from pg_catalog.pg_attribute a
   where a.attrelid = pg_catalog.to_regclass('public.account_entries')
     and a.attnum > 0
     and not a.attisdropped
     and a.attname in ('revision', 'deleted', 'sync_seq');
  if v_existing is not null then
    raise exception 'Account sync columns already present on public.account_entries: %', v_existing
      using errcode = 'P0001',
            hint = 'Do NOT drop them to make this migration fit: that can erase tombstone/revision state. Export the rows and reconcile by hand, then re-run 0000_preflight.sql.';
  end if;
end
$columns$;

alter table public.account_entries
  add column revision bigint not null default 1;
alter table public.account_entries
  add column deleted boolean not null default false;
-- sync_seq is the pull cursor: a bigint assigned by the writer while it holds the
-- per-owner advisory lock (section 4). Existing rows are backfilled in one sweep
-- below; no default is left on the column so only the writer can assign it.
alter table public.account_entries
  add column sync_seq bigint;

-- The draft applied this column nullable (`on delete cascade`); NOT NULL is
-- required so the RPC can never insert an unowned row.
alter table public.account_entries
  alter column owner_id set not null;

-- Backfill the cursor for rows that already exist, then forbid NULLs. nextval
-- allocates distinct values; existing rows all commit before any client can pull,
-- so their relative order is irrelevant to correctness.
create sequence public.account_entries_sync_seq as bigint;
update public.account_entries
   set sync_seq = pg_catalog.nextval('public.account_entries_sync_seq'::pg_catalog.regclass)
 where sync_seq is null;
alter table public.account_entries
  alter column sync_seq set not null;

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
alter table public.account_entries
  add constraint account_entries_sync_seq_check
  check (sync_seq >= 1);
-- A tombstone always stores an empty object; a live row may legitimately hold an
-- empty object too (an entry with nothing filled in yet), so only the tombstone
-- side is constrained.
alter table public.account_entries
  add constraint account_entries_tombstone_payload_check
  check (not deleted or payload = '{}'::jsonb);

-- Ownership key. This is the key `on conflict (owner_id, id)` and the RPC's
-- insert both rely on, so it must be a VALID, NON-PARTIAL unique index on exactly
-- those two columns. An invalid index (indisvalid = false) is not usable, and a
-- partial one (indpred is not null) is not inferable by ON CONFLICT: accepting
-- either here would move the failure to a client write at runtime.
do $ownkey$
declare
  v_ok  boolean;
  v_bad boolean;
begin
  select exists (
    select 1
      from pg_catalog.pg_index i
     where i.indrelid = 'public.account_entries'::pg_catalog.regclass
       and i.indisunique
       and i.indisvalid
       and i.indpred is null
       and (
             select pg_catalog.array_agg(a.attname::text order by a.attname::text)
               from pg_catalog.pg_attribute a
              where a.attrelid = i.indrelid
                and a.attnum = any (i.indkey::smallint[])
           ) = array['id', 'owner_id']::text[]
  ) into v_ok;

  select exists (
    select 1
      from pg_catalog.pg_index i
     where i.indrelid = 'public.account_entries'::pg_catalog.regclass
       and (not i.indisvalid or i.indpred is not null)
       and (
             select pg_catalog.array_agg(a.attname::text order by a.attname::text)
               from pg_catalog.pg_attribute a
              where a.attrelid = i.indrelid
                and a.attnum = any (i.indkey::smallint[])
           ) = array['id', 'owner_id']::text[]
  ) into v_bad;

  if v_bad then
    raise exception 'A partial or invalid unique index exists on public.account_entries (owner_id, id)'
      using errcode = 'P0001',
            hint = 'Drop or reindex it first: ON CONFLICT (owner_id, id) cannot use it, so the RPC would fail at runtime.';
  end if;

  if not v_ok then
    alter table public.account_entries
      add constraint account_entries_owner_id_id_key unique (owner_id, id);
  end if;
end
$ownkey$;

-- Pull ordering index for the sync_seq cursor. Unique, so a cursor value can
-- never belong to two owner rows at once; the RPC orders by (sync_seq) alone.
create unique index account_entries_owner_sync_seq_idx
  on public.account_entries (owner_id, sync_seq);

-- ---------------------------------------------------------------------------
-- 2. Retire the previous write path AND every policy that is not ours.
--
--    Dropping only the known draft names was not enough: any other permissive
--    SELECT policy is OR-combined with the policy created below and would widen
--    reads (possibly other owners' rows or tombstones). This drops every policy
--    on the table by name, then installs exactly one.
-- ---------------------------------------------------------------------------
alter table public.account_entries enable row level security;

do $policies$
declare
  v_policy record;
begin
  for v_policy in
    select p.policyname
      from pg_catalog.pg_policies p
     where p.schemaname = 'public'
       and p.tablename = 'account_entries'
  loop
    execute pg_catalog.format('drop policy %I on public.account_entries', v_policy.policyname);
  end loop;
end
$policies$;

-- No client-issued privilege survives, including the implicit PUBLIC grant that
-- `create table` adds by default and any inherited/custom role grant. `revoke
-- all` also removes TRUNCATE/REFERENCES/TRIGGER, not just the write words.
revoke all on public.account_entries from authenticated, anon, public;
grant select on public.account_entries to authenticated;

-- Owner-scoped reads, live rows only. Tombstones are written with
-- deleted = true and hidden here; the pull RPC (security definer) sees them.
-- `(select auth.uid())` is evaluated once per statement instead of per row.
create policy account_entries_select_own_live
  on public.account_entries
  for select
  to authenticated
  using ((select auth.uid()) = owner_id and not deleted);

-- ACL assertion: after the revoke/grant above, the only explicit ACL entries on
-- this table may be the owner, `authenticated` with SELECT, and trusted
-- server-side roles (superuser/BYPASSRLS — server keys, never the browser). Any
-- other grantee means the isolation surface is not what this migration assumes,
-- so abort instead of leaving a silent read path.
do $aclcheck$
declare
  v_oid       oid := 'public.account_entries'::pg_catalog.regclass;
  v_owner     name;
  v_grantee   text;
  v_trusted   boolean;
begin
  select pg_catalog.pg_get_userbyid(c.relowner)
    into v_owner
    from pg_catalog.pg_class c
   where c.oid = v_oid;

  for v_grantee in
    select distinct
           case when x.grantee = 0 then 'PUBLIC'
                else pg_catalog.pg_get_userbyid(x.grantee) end
      from pg_catalog.pg_class c,
           lateral pg_catalog.aclexplode(
             coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
           ) x
     where c.oid = v_oid
  loop
    -- Only the owner and `authenticated` (SELECT only, checked below) may remain
    -- after the revoke above. PUBLIC must be empty; any other role must be a
    -- trusted server-side role (superuser/BYPASSRLS), never a browser identity.
    if v_grantee not in (v_owner, 'authenticated') then
      if v_grantee = 'PUBLIC' then
        raise exception 'PUBLIC still holds a privilege on public.account_entries'
          using errcode = 'P0001',
                hint = 'The revoke above should have removed it; reconcile the ACL before applying.';
      end if;
      select exists (
        select 1 from pg_catalog.pg_roles r
         where r.rolname = v_grantee
           and (r.rolsuper or r.rolbypassrls)
      ) into v_trusted;
      if not v_trusted then
        raise exception 'Unexpected grantee % still holds a privilege on public.account_entries', coalesce(v_grantee, '<null>')
          using errcode = 'P0001',
                hint = 'Revoke it, or reconcile the ACL before applying. The client surface must be RPC-only.';
      end if;
    end if;
  end loop;

  if pg_catalog.has_table_privilege('authenticated', 'public.account_entries', 'INSERT')
     or pg_catalog.has_table_privilege('authenticated', 'public.account_entries', 'UPDATE')
     or pg_catalog.has_table_privilege('authenticated', 'public.account_entries', 'DELETE') then
    raise exception 'authenticated still holds a write privilege on public.account_entries'
      using errcode = 'P0001';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.account_entries', 'SELECT')
     or pg_catalog.has_table_privilege('anon', 'public.account_entries', 'INSERT')
     or pg_catalog.has_table_privilege('anon', 'public.account_entries', 'UPDATE')
     or pg_catalog.has_table_privilege('anon', 'public.account_entries', 'DELETE') then
    raise exception 'anon still holds a privilege on public.account_entries'
      using errcode = 'P0001';
  end if;
end
$aclcheck$;

-- ---------------------------------------------------------------------------
-- 3. Applied-operation log. The RPC is its only reader/writer; RLS with no
--    policies means even a future privilege mistake is inert.
--
--    Each row is bound to the FULL request it acknowledges, not just entry_id:
--      expected_revision — the revision the client believed it was replacing;
--      payload_hash      — sha256 of the request payload as canonical jsonb text;
--      deleted           — the requested tombstone flag.
--    A retry must repeat all of them. Reusing an operation_id for different
--    content is a controlled 22023 error, never a unique-violation crash.
--    produced_revision is the revision this operation itself created (>= 1; a
--    create that inserts a tombstone still produces revision 1).
-- ---------------------------------------------------------------------------
create table public.sync_operations (
  owner_id          uuid        not null references auth.users (id) on delete cascade,
  operation_id      uuid        not null,
  entry_id          uuid        not null,
  expected_revision bigint      not null check (expected_revision >= 0),
  payload_hash      text        not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  deleted           boolean     not null,
  produced_revision bigint      not null check (produced_revision >= 1),
  created_at        timestamptz not null default now(),
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
--   errors (SQLSTATE 42501 / 22023) — authentication missing, invalid input, or
--                               an operation_id reused with different content:
--                               nothing is written and the caller may fix and retry.
--
-- Semantics
--   p_expected_revision = 0 creates, and only creates: if a row already exists at
--   p_id the call is a conflict, never an overwrite. p_expected_revision > 0 must
--   match `revision` or the call is a conflict. Deleting stores a tombstone with
--   payload '{}' and deleted = true; p_payload is accepted (and ignored for
--   storage) on a delete so a queued entry body is never a reason to fail a
--   delete — but it is still hashed into the operation binding.
--   RESURRECT RULE: a deleted row is not special on the write path. A create or
--   update for a tombstoned id whose p_expected_revision matches the tombstone's
--   revision applies as an ordinary update (revision + 1, deleted becomes false).
--   This is what makes "delete on one device, edit on another, reconnect" converge.
--   Clients recover from conflict/tombstone state accordingly.
--
-- Concurrency (why this is now deterministic)
--   1. The function first takes a per-owner transaction-scoped advisory lock.
--      Every write for one account is therefore strictly serialised, and the
--      lock is released only when the transaction commits or rolls back. Two
--      concurrent calls with the same operation_id cannot both miss the log:
--      the second waits, then finds the committed row and returns
--      `already_applied`. It can never return `conflict` for a lost create race.
--   2. Only after the log lookup (and, when needed, the entry lock) does the
--      function write. A conflict returns without recording an operation, so a
--      corrected retry with the same operation_id is still allowed to apply.
--   3. sync_seq is allocated inside that same lock, so for a given owner the
--      sequence order equals the commit order (section 5 depends on this).
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
  v_payload_hash text;
  v_seq bigint;
  v_exists boolean;
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

  -- Per-owner serialisation. Held until this transaction ends. Taking it before
  -- any row lock also fixes the lock order for every path, so concurrent senders
  -- for one account cannot deadlock each other.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stillroom.account_sync:' || v_uid::text, 0)
  );

  -- jsonb text output is canonical (key order/whitespace normalised), so an
  -- identical JSON body hashes identically on every retry.
  v_payload_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_payload::text, 'UTF8')),
    'hex'
  );

  -- Idempotency first: consult the log before touching the entry row.
  select * into v_applied
    from public.sync_operations
   where owner_id = v_uid
     and operation_id = p_operation_id;

  if found then
    if v_applied.entry_id <> p_id
       or v_applied.expected_revision <> p_expected_revision
       or v_applied.payload_hash <> v_payload_hash
       or v_applied.deleted <> p_deleted then
      raise exception 'Operation ID was already used for different content'
        using errcode = '22023',
              hint = 'A retry must repeat the original operation_id with the same entry id, expected revision, payload and deleted flag.';
    end if;

    -- Stored values would be stale if a later operation advanced the row.
    -- Report the row's current state; the caller re-runs its reconcile.
    select * into v_row
      from public.account_entries
     where owner_id = v_uid
       and id = v_applied.entry_id;
    if found then
      return query select 'already_applied'::text, v_row.revision, v_row.payload,
                          v_row.deleted, v_applied.produced_revision;
    else
      -- The row was removed after this operation (out-of-band reset). Report the
      -- absence, not stale data.
      return query select 'already_applied'::text, 0::bigint, '{}'::jsonb,
                          true, v_applied.produced_revision;
    end if;
    return;
  end if;

  -- Entry row, guarded by the owner column. The advisory lock already
  -- serialises writers for this owner; FOR UPDATE is kept for defence in depth.
  select * into v_row
    from public.account_entries
   where owner_id = v_uid
     and id = p_id
   for update;
  v_exists := found;

  if v_exists then
    if v_row.revision <> p_expected_revision then
      -- Includes the expected p_expected_revision = 0 while the row exists.
      return query select 'conflict'::text, v_row.revision, v_row.payload,
                          v_row.deleted, null::bigint;
      return;
    end if;
    v_revision := v_row.revision + 1;
  else
    if p_expected_revision <> 0 then
      return query select 'conflict'::text, 0::bigint, '{}'::jsonb,
                          false, null::bigint;
      return;
    end if;
    v_revision := 1;
  end if;

  v_deleted := p_deleted;
  v_payload := case when p_deleted then '{}'::jsonb else p_payload end;
  -- Assign the cursor while the advisory lock is held: allocation order equals
  -- commit order for this owner, which is what makes the pull cursor skip-safe.
  v_seq := pg_catalog.nextval('public.account_entries_sync_seq'::pg_catalog.regclass);

  if v_exists then
    update public.account_entries as ae
       set revision = v_revision,
           payload = v_payload,
           deleted = v_deleted,
           sync_seq = v_seq,
           updated_at = pg_catalog.now()
     where ae.owner_id = v_uid
       and ae.id = p_id;
  else
    -- A create that carries a tombstone (create-then-delete before any sync)
    -- inserts the tombstone directly; otherwise this is a live revision-1 row.
    -- The unique (owner_id, id) key is a backstop: a duplicate would abort the
    -- transaction rather than silently create a second row.
    insert into public.account_entries
      (owner_id, id, payload, revision, deleted, sync_seq, updated_at)
    values
      (v_uid, p_id, v_payload, v_revision, v_deleted, v_seq, pg_catalog.now());
  end if;

  -- Record the operation only after the change is decided and applied, so a
  -- conflict never leaves a log entry that would fake an already_applied retry.
  insert into public.sync_operations
    (owner_id, operation_id, entry_id, expected_revision, payload_hash, deleted,
     produced_revision, created_at)
  values
    (v_uid, p_operation_id, p_id, p_expected_revision, v_payload_hash, p_deleted,
     v_revision, pg_catalog.now());

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
-- public.list_account_entries(p_after_seq bigint, p_limit integer)
--   returns (id uuid, revision bigint, payload jsonb, deleted boolean,
--            updated_at timestamptz, sync_seq bigint)
--
--   Caller-owned rows, tombstones INCLUDED (deleted = true, payload '{}'),
--   ordered by sync_seq ascending, filtered by `sync_seq > p_after_seq`.
--   p_after_seq null means "from the beginning"; p_limit is clamped to 1..500.
--   Contract: page until a page returns fewer than `limit` rows, resuming from
--   the last row's sync_seq. updated_at is informational only and must NOT be
--   used as a cursor.
--
--   Why a direct RLS select is not used: the select policy hides tombstones
--   (they are an internal representation) and RLS also re-filters any security
--   invoker query. This definer function returns exactly the caller's rows,
--   including tombstones, and nothing else.
--
--   CURSOR SAFETY (why sync_seq cannot skip or duplicate a committed row)
--   * sync_seq is allocated by nextval() only inside apply_entry_change, while
--     that account's advisory lock is held, and the lock is released only at
--     commit. So for one owner, allocation order and COMMIT order are the same.
--   * The function returns rows in ascending sync_seq and resumes at the largest
--     sync_seq it has returned, strictly excluding it (`sync_seq > cursor`).
--   * Suppose a client has received cursor C (the largest seq returned so far).
--     Every owner row with sync_seq <= C was allocated and committed before the
--     row carrying C (allocation = commit order), so it was already visible to
--     the snapshot that produced C. A page returns the smallest `limit` seqs
--     above the previous cursor, so any such row is either on this page (if
--     above the previous cursor) or on an earlier page (induction). Therefore no
--     committed row can be left permanently behind the cursor.
--   * A row that is later updated gets a NEW, larger sync_seq, so it reappears
--     above any cursor rather than being missed. A timestamp cursor had neither
--     property: `now()` is transaction start time (it can move backwards for a
--     waiting writer), and ties on an equal timestamp split across a page
--     boundary were unrecoverable.
--   * Values are unique (sequence) and the (owner_id, sync_seq) index is unique,
--     so a cursor value cannot match two rows.
-- ---------------------------------------------------------------------------
create function public.list_account_entries(
  p_after_seq bigint,
  p_limit integer
)
returns table (
  id uuid,
  revision bigint,
  payload jsonb,
  deleted boolean,
  updated_at timestamptz,
  sync_seq bigint
)
language sql
security definer
set search_path = ''
stable
as $list$
  select ae.id, ae.revision, ae.payload, ae.deleted, ae.updated_at, ae.sync_seq
    from public.account_entries as ae
   where ae.owner_id = auth.uid()
     and (p_after_seq is null or ae.sync_seq > p_after_seq)
   order by ae.sync_seq
   limit least(greatest(coalesce(p_limit, 500), 1), 500)
$list$;

revoke all on function public.list_account_entries(bigint, integer)
  from public, anon;
grant execute on function public.list_account_entries(bigint, integer)
  to authenticated;

commit;
