-- Stillroom account sync — migration 0000: PREFLIGHT (read-only).
--
-- RUN THIS BEFORE 0001_account_sync.sql. It changes nothing: every statement is
-- an inventory SELECT or a check inside a read-only DO block.
--
-- It exists because 0001 ALTERs a table it did not create and installs the only
-- read/write path clients will have. If the real catalog differs from what 0001
-- assumes, 0001 must fail before it touches RLS, privileges or data — and a
-- human must decide what to do. Nothing here decides that for you.
--
-- HOW TO READ THE OUTPUT
--   * Sections A–G print the real catalog state: columns, policies, privileges
--     (explicit ACL, per-role effective privileges, column grants), indexes with
--     indisvalid/indpred, constraints, functions with signature/security, and
--     any name this migration reserves.
--   * The final `do $preflight$` block re-checks the few assumptions 0001 cannot
--     tolerate. If everything matches it emits `NOTICE: PREFLIGHT OK`.
--     Otherwise it RAISES and lists every problem. **The error is the stop
--     signal: resolve each problem (or reconcile the table by hand) before
--     applying 0001.** Do not edit 0001 to fit a different table.
--
-- WHAT 0001 ASSUMES (and therefore what this file enforces)
--   1. public.account_entries is an ordinary/partitioned table with RLS enabled.
--   2. It has owner_id uuid not null, id uuid not null, payload jsonb not null,
--      updated_at timestamptz not null. Extra columns are tolerated.
--   3. The sync columns revision/deleted/sync_seq do NOT exist yet. 0001 adds
--      them unconditionally; if any of them already exists, 0001 aborts rather
--      than resetting revision/tombstone state a previous attempt left behind.
--      A human must export and reconcile that state first.
--   4. There is a valid, non-partial PRIMARY KEY or UNIQUE index on exactly
--      (owner_id, id), or 0001 can add one because (owner_id, id) has no
--      duplicates. A partial or invalid candidate is a stop: `on conflict
--      (owner_id, id)` cannot infer it and would fail at runtime.
--   5. public.sync_operations and the sequence public.account_entries_sync_seq
--      do NOT exist; 0001 creates both. Neither may pre-exist.
--   6. public.apply_entry_change / public.list_account_entries do NOT exist
--      under any signature; 0001 creates them.
--   7. No unexplained role holds an explicit grant on the table. Roles that are
--      superusers or have BYPASSRLS (server-side keys, never the browser) are
--      reported and tolerated; any other grantee is a stop.
--
-- This file is deliberately fail-closed: an unrecognised shape stops 0001.

begin read only;

-- ---------------------------------------------------------------------------
-- A. Table identity, RLS and every column.
-- ---------------------------------------------------------------------------
select 'A1. table' as section,
       n.nspname as schema_name,
       c.relname as table_name,
       c.relkind as relkind,               -- 'r' ordinary, 'p' partitioned
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       pg_catalog.pg_get_userbyid(c.relowner) as table_owner,
       c.relacl::text as acl
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname = 'account_entries';

select 'A2. columns' as section,
       a.attname as column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
       a.attnotnull as not_null,
       pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr
  from pg_catalog.pg_attribute a
  left join pg_catalog.pg_attrdef d
         on d.adrelid = a.attrelid and d.adnum = a.attnum
 where a.attrelid = pg_catalog.to_regclass('public.account_entries')
   and a.attnum > 0
   and not a.attisdropped
 order by a.attnum;

-- ---------------------------------------------------------------------------
-- B. Every policy on the table. 0001 drops all of them, whatever their name:
--    a permissive SELECT policy that survived would be OR-combined with the new
--    owner-only policy and could expose other owners' rows or tombstones.
-- ---------------------------------------------------------------------------
select 'B. policies' as section,
       p.policyname,
       p.permissive,
       p.roles::text as roles,
       p.cmd,
       p.qual,
       p.with_check
  from pg_catalog.pg_policies p
 where p.schemaname = 'public'
   and p.tablename = 'account_entries'
 order by p.policyname;

-- ---------------------------------------------------------------------------
-- C. Privileges. Three views, because each misses something:
--    C1 explicit ACL entries (includes PUBLIC and inherited-from-nothing),
--    C2 effective privileges per role (shows inheritance into logins),
--    C3 column-level grants (would survive a table-level revoke).
-- ---------------------------------------------------------------------------
select 'C1. explicit ACL' as section,
       case when x.grantee = 0 then 'PUBLIC'
            else pg_catalog.pg_get_userbyid(x.grantee) end as grantee,
       x.privilege_type,
       x.is_grantable
  from pg_catalog.pg_class c,
       lateral pg_catalog.aclexplode(
         coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
       ) x
 where c.oid = pg_catalog.to_regclass('public.account_entries')
 order by 2, 3;

select 'C2. effective privileges' as section,
       r.rolname,
       r.rolinherit,
       r.rolsuper,
       r.rolbypassrls,
       pg_catalog.has_table_privilege(r.rolname, 'public.account_entries', 'SELECT') as can_select,
       pg_catalog.has_table_privilege(r.rolname, 'public.account_entries', 'INSERT') as can_insert,
       pg_catalog.has_table_privilege(r.rolname, 'public.account_entries', 'UPDATE') as can_update,
       pg_catalog.has_table_privilege(r.rolname, 'public.account_entries', 'DELETE') as can_delete
  from pg_catalog.pg_roles r
  cross join pg_catalog.pg_class c
 where c.oid = pg_catalog.to_regclass('public.account_entries')
   and (r.rolcanlogin or r.rolname in ('anon', 'authenticated'))
 order by r.rolname;

select 'C3. column privileges' as section,
       cp.grantee,
       cp.column_name,
       cp.privilege_type
  from information_schema.column_privileges cp
 where cp.table_schema = 'public'
   and cp.table_name = 'account_entries'
 order by cp.grantee, cp.column_name, cp.privilege_type;

-- ---------------------------------------------------------------------------
-- D. Every index with its validity and partiality. A partial or invalid unique
--    index on (owner_id, id) is exactly the trap 0001 must not accept.
-- ---------------------------------------------------------------------------
select 'D. indexes' as section,
       ic.relname as index_name,
       i.indisprimary as is_primary,
       i.indisunique as is_unique,
       i.indisvalid as is_valid,
       (i.indpred is not null) as is_partial,
       pg_catalog.pg_get_indexdef(i.indexrelid) as definition
  from pg_catalog.pg_index i
  join pg_catalog.pg_class ic on ic.oid = i.indexrelid
 where i.indrelid = pg_catalog.to_regclass('public.account_entries')
 order by ic.relname;

-- ---------------------------------------------------------------------------
-- E. Every constraint on the table.
-- ---------------------------------------------------------------------------
select 'E. constraints' as section,
       con.conname,
       con.contype,
       con.convalidated as is_validated,
       pg_catalog.pg_get_constraintdef(con.oid) as definition
  from pg_catalog.pg_constraint con
 where con.conrelid = pg_catalog.to_regclass('public.account_entries')
 order by con.conname;

-- ---------------------------------------------------------------------------
-- F. Every existing function in public, with signature, security mode and
--    settings, so an old save_library_entry/apply_entry_change relic is visible.
-- ---------------------------------------------------------------------------
select 'F. functions' as section,
       p.proname,
       pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,
       coalesce(p.proconfig::text, 'NULL') as proconfig,
       coalesce(p.proacl::text, 'NULL') as proacl
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
 order by p.proname, arguments;

-- ---------------------------------------------------------------------------
-- G. Names 0001 reserves. Any hit here means 0001 would fail (or silently
--    overload) — resolve by hand first.
-- ---------------------------------------------------------------------------
select 'G. reserved names' as section,
       'public.sync_operations' as name,
       (pg_catalog.to_regclass('public.sync_operations') is not null) as already_exists
union all
select 'G. reserved names',
       'public.account_entries_sync_seq',
       (pg_catalog.to_regclass('public.account_entries_sync_seq') is not null)
union all
select 'G. reserved names',
       'public.account_entries_owner_sync_seq_idx',
       (pg_catalog.to_regclass('public.account_entries_owner_sync_seq_idx') is not null)
union all
select 'G. reserved names',
       'public.account_entries_owner_id_id_key',
       exists (
         select 1 from pg_catalog.pg_constraint con
          where con.conrelid = pg_catalog.to_regclass('public.account_entries')
            and con.conname = 'account_entries_owner_id_id_key'
       );

-- ---------------------------------------------------------------------------
-- Final gate. Raises with the complete list of problems, or a NOTICE when the
-- table matches what 0001 assumes.
-- ---------------------------------------------------------------------------
do $preflight$
declare
  v_oid              oid := pg_catalog.to_regclass('public.account_entries');
  v_relkind          "char";
  v_rls              boolean;
  v_owner            name;
  v_problems         text[] := array[]::text[];
  v_grantee          text;
  v_grantee_trusted  boolean;
  v_key_valid        boolean := false;
  v_key_bad          boolean := false;
  v_dupes            bigint := 0;
  v_sync_columns     text[] := array[]::text[];
begin
  if v_oid is null then
    raise exception 'PREFLIGHT FAILED: public.account_entries does not exist'
      using errcode = 'P0001',
            hint = 'Create the table first (see supabase/account-entries.sql) or point the migration at the real table. Nothing was modified.';
  end if;

  select c.relkind, c.relrowsecurity
    into v_relkind, v_rls
    from pg_catalog.pg_class c
   where c.oid = v_oid;

  if v_relkind not in ('r', 'p') then
    v_problems := v_problems || pg_catalog.format(
      'public.account_entries has relkind %s; 0001 only alters an ordinary or partitioned table', v_relkind);
  end if;
  if not v_rls then
    v_problems := v_problems || 'row level security is not enabled on public.account_entries';
  end if;

  -- 2. Required columns.
  if not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = v_oid and a.attname = 'owner_id'
       and a.attnum > 0 and not a.attisdropped
       and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'uuid'
       and a.attnotnull
  ) then
    v_problems := v_problems || 'owner_id must exist as uuid not null';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = v_oid and a.attname = 'id'
       and a.attnum > 0 and not a.attisdropped
       and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'uuid'
       and a.attnotnull
  ) then
    v_problems := v_problems || 'id must exist as uuid not null';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = v_oid and a.attname = 'payload'
       and a.attnum > 0 and not a.attisdropped
       and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'jsonb'
       and a.attnotnull
  ) then
    v_problems := v_problems || 'payload must exist as jsonb not null';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = v_oid and a.attname = 'updated_at'
       and a.attnum > 0 and not a.attisdropped
       and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
       and a.attnotnull
  ) then
    v_problems := v_problems || 'updated_at must exist as timestamp with time zone not null';
  end if;

  -- 3. Sync columns must be absent: 0001 must never reset prior sync state.
  select pg_catalog.array_agg(a.attname::text order by a.attname::text)
    into v_sync_columns
    from pg_catalog.pg_attribute a
   where a.attrelid = v_oid
     and a.attnum > 0 and not a.attisdropped
     and a.attname in ('revision', 'deleted', 'sync_seq');
  if v_sync_columns is not null then
    v_problems := v_problems || pg_catalog.format(
      'sync columns already exist (%s); 0001 aborts rather than reset revision/tombstone state. Export those rows and reconcile by hand first',
      pg_catalog.array_to_string(v_sync_columns, ', '));
  end if;

  -- 4. Ownership key: a valid, non-partial unique index/constraint on exactly
  --    (owner_id, id), or no duplicates so 0001 can add it.
  select exists (
    select 1
      from pg_catalog.pg_index i
     where i.indrelid = v_oid
       and i.indisunique
       and i.indisvalid
       and i.indpred is null
       and (
             select pg_catalog.array_agg(a.attname::text order by a.attname::text)
               from pg_catalog.pg_attribute a
              where a.attrelid = i.indrelid
                and a.attnum = any (i.indkey::smallint[])
           ) = array['id', 'owner_id']::text[]
  ) into v_key_valid;

  select exists (
    select 1
      from pg_catalog.pg_index i
     where i.indrelid = v_oid
       and (not i.indisvalid or i.indpred is not null)
       and (
             select pg_catalog.array_agg(a.attname::text order by a.attname::text)
               from pg_catalog.pg_attribute a
              where a.attrelid = i.indrelid
                and a.attnum = any (i.indkey::smallint[])
           ) = array['id', 'owner_id']::text[]
  ) into v_key_bad;

  if v_key_bad then
    v_problems := v_problems || 'a partial or invalid unique index on (owner_id, id) exists; drop or reindex it first (ON CONFLICT cannot infer it)';
  end if;

  if not v_key_valid then
    execute 'select count(*) from ('
         || 'select owner_id, id from public.account_entries '
         || 'group by owner_id, id having count(*) > 1) d'
      into v_dupes;
    if v_dupes > 0 then
      v_problems := v_problems || pg_catalog.format(
        '%s duplicate (owner_id, id) group(s) exist; 0001 cannot add the key', v_dupes);
    end if;
  end if;

  -- 7. No unexplained grantee. Superuser/BYPASSRLS roles are server-side keys
  --    and are reported by C1/C2 but tolerated here; anything else must be
  --    revoked or reconciled by hand.
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
    if v_grantee not in (v_owner, 'authenticated', 'anon', 'PUBLIC') then
      select exists (
        select 1 from pg_catalog.pg_roles r
         where r.rolname = v_grantee
           and (r.rolsuper or r.rolbypassrls)
      ) into v_grantee_trusted;
      if not v_grantee_trusted then
        v_problems := v_problems || pg_catalog.format(
          'unexpected explicit grantee %s on public.account_entries; revoke it or reconcile the ACL',
          coalesce(v_grantee, '<null>'));
      end if;
    end if;
  end loop;

  -- 5. Reserved objects must not exist.
  if pg_catalog.to_regclass('public.sync_operations') is not null then
    v_problems := v_problems || 'public.sync_operations already exists; 0001 creates it from scratch';
  end if;
  if pg_catalog.to_regclass('public.account_entries_sync_seq') is not null then
    v_problems := v_problems || 'sequence public.account_entries_sync_seq already exists; 0001 creates it';
  end if;
  if pg_catalog.to_regclass('public.account_entries_owner_sync_seq_idx') is not null then
    v_problems := v_problems || 'index public.account_entries_owner_sync_seq_idx already exists; 0001 creates it';
  end if;

  -- 6. Reserved functions must not exist under any signature.
  if exists (
    select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('apply_entry_change', 'list_account_entries')
  ) then
    v_problems := v_problems || 'public.apply_entry_change or public.list_account_entries already exists; 0001 would fail or create an ambiguous overload';
  end if;

  if pg_catalog.array_length(v_problems, 1) is not null then
    raise exception 'PREFLIGHT FAILED: % problem(s) found. Nothing was modified.', pg_catalog.array_length(v_problems, 1)
      using errcode = 'P0001',
            hint = pg_catalog.array_to_string(v_problems, ' | ');
  end if;

  raise notice 'PREFLIGHT OK: public.account_entries matches the shape 0001_account_sync.sql assumes.';
end
$preflight$;

commit;
