-- Stillroom account sync — migration 0002: POST-APPLY VERIFICATION (read-only).
--
-- Apply 0001_account_sync.sql first, then paste this whole file into the same
-- Supabase SQL editor. It changes nothing: every statement is a SELECT.
--
-- Read the output table by table. Every row must say "EXPECTED"; a row that says
-- "UNEXPECTED ..." lists the invariants that failed, and you should roll back
-- 0001 with the statement in supabase/README.md §6 before writing any data.
--
-- This file is intentionally repeated from 0001's comments: it is the audit a
-- human runs, not a claim that the migration is correct.

begin read only;

-- ---------------------------------------------------------------------------
-- A. Tables: existence, RLS, constraints, columns.
-- Expect: exactly two rows, both rls = true, both EXPECTED.
-- ---------------------------------------------------------------------------
with expected_columns(relname, column_name) as (
  values ('account_entries', 'owner_id'),
         ('account_entries', 'id'),
         ('account_entries', 'payload'),
         ('account_entries', 'updated_at'),
         ('account_entries', 'revision'),
         ('account_entries', 'deleted'),
         ('sync_operations', 'owner_id'),
         ('sync_operations', 'operation_id'),
         ('sync_operations', 'entry_id'),
         ('sync_operations', 'revision'),
         ('sync_operations', 'created_at')
),
missing as (
  select e.relname, e.column_name
    from expected_columns e
   where not exists (
     select 1
       from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = e.relname
        and c.column_name = e.column_name
   )
),
table_state as (
  select c.relname,
         c.relrowsecurity as rls_enabled,
         (select count(*) from missing m where m.relname = c.relname) as missing_columns,
         (select bool_or(k.constraint_name is not null)
            from (values ('account_entries_payload_object_check'),
                         ('account_entries_payload_size_check'),
                         ('account_entries_revision_check'),
                         ('account_entries_tombstone_payload_check')) as x(n)
            left join information_schema.table_constraints k
                   on k.table_schema = 'public' and k.table_name = c.relname
                  and k.constraint_name = x.n
          ) as named_checks_present
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('account_entries', 'sync_operations')
)
select 'A. tables' as check_group,
       relname as object,
       case
         when missing_columns > 0 then 'UNEXPECTED: missing columns ' ||
              (select string_agg(m.column_name, ', ' order by m.column_name)
                 from missing m where m.relname = table_state.relname)
         when not rls_enabled then 'UNEXPECTED: row level security is not enabled'
         else 'EXPECTED'
       end as verdict,
       rls_enabled
  from table_state
 order by relname;

-- A2. Ownership key (owner_id, id) must be a primary key or unique constraint.
select 'A2. ownership key' as check_group,
       'account_entries (owner_id, id)' as object,
       case when exists (
              select 1
                from pg_catalog.pg_constraint c
               where c.conrelid = 'public.account_entries'::regclass
                 and c.contype in ('p', 'u')
                 and (
                       select array_agg(a.attname::text order by a.attname::text)
                         from pg_catalog.pg_attribute a
                        where a.attrelid = c.conrelid
                          and a.attnum = any (c.conkey)
                     ) = array['id', 'owner_id']::text[]
            )
            then 'EXPECTED' else 'UNEXPECTED: no unique/primary key on (owner_id, id)' end
       as verdict;

-- A3. Rows added by 0001 must be safe for existing data (no tombstones with
--     content, no oversized payloads, no revision below 1).
select 'A3. data fits constraints' as check_group,
       'account_entries' as object,
       case when count(*) = 0 then 'EXPECTED' else 'UNEXPECTED: ' || count(*) || ' row(s) violate' end as verdict
  from public.account_entries
 where revision < 1
    or jsonb_typeof(payload) <> 'object'
    or pg_column_size(payload) > 262144
    or (deleted and payload <> '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- B. Client privileges. authenticated may only SELECT account_entries;
--    nothing on sync_operations is reachable by any client role.
-- Expect: 4 rows, all EXPECTED.
-- ---------------------------------------------------------------------------
with privileges(relname, role_name, priv, wanted) as (
  values ('account_entries', 'anon', 'SELECT', false),
         ('account_entries', 'anon', 'INSERT', false),
         ('account_entries', 'anon', 'UPDATE', false),
         ('account_entries', 'anon', 'DELETE', false),
         ('account_entries', 'authenticated', 'SELECT', true),
         ('account_entries', 'authenticated', 'INSERT', false),
         ('account_entries', 'authenticated', 'UPDATE', false),
         ('account_entries', 'authenticated', 'DELETE', false),
         ('sync_operations', 'anon', 'SELECT', false),
         ('sync_operations', 'anon', 'INSERT', false),
         ('sync_operations', 'authenticated', 'SELECT', false),
         ('sync_operations', 'authenticated', 'INSERT', false),
         ('sync_operations', 'authenticated', 'UPDATE', false),
         ('sync_operations', 'authenticated', 'DELETE', false)
)
select 'B. client privileges' as check_group,
       p.relname || ' ' || p.role_name || ' ' || p.priv as object,
       case when has_table_privilege(p.role_name, 'public.' || p.relname, p.priv) = p.wanted
            then 'EXPECTED'
            else 'UNEXPECTED: has_table_privilege = ' ||
                 has_table_privilege(p.role_name, 'public.' || p.relname, p.priv)::text
       end as verdict,
       has_table_privilege(p.role_name, 'public.' || p.relname, p.priv) as grant_present
  from privileges p
 order by p.relname, p.role_name, p.priv;

-- ---------------------------------------------------------------------------
-- C. Policies. account_entries: exactly one SELECT policy for authenticated,
--    no INSERT/UPDATE/DELETE policy. sync_operations: none at all.
-- Expect: 2 rows, both EXPECTED.
-- ---------------------------------------------------------------------------
select 'C. policies' as check_group,
       'account_entries' as object,
       case
         when exists (select 1 from pg_policies
                       where schemaname = 'public' and tablename = 'account_entries'
                         and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL'))
           then 'UNEXPECTED: a write policy still exists'
         when (select count(*) from pg_policies
                where schemaname = 'public' and tablename = 'account_entries'
                  and cmd = 'SELECT'
                  and roles = array['authenticated']::name[]) <> 1
           then 'UNEXPECTED: expected exactly one authenticated SELECT policy'
         when not exists (select 1 from pg_policies
                           where schemaname = 'public' and tablename = 'account_entries'
                             and cmd = 'SELECT'
                             and qual like '%auth.uid()%'
                             and qual like '%owner_id%')
           then 'UNEXPECTED: SELECT policy does not scope by auth.uid() = owner_id'
         else 'EXPECTED'
       end as verdict
union all
select 'C. policies',
       'sync_operations',
       case when exists (select 1 from pg_policies
                          where schemaname = 'public' and tablename = 'sync_operations')
            then 'UNEXPECTED: sync_operations must have no policies'
            else 'EXPECTED' end;

-- ---------------------------------------------------------------------------
-- D. Functions. security definer, empty search_path, no PUBLIC/anon execute,
--    authenticated execute present, own-body not executable by clients.
-- Expect: 2 rows, all EXPECTED.
-- ---------------------------------------------------------------------------
with funcs(sig, name, argc, authenticated_exec) as (
  values ('public.apply_entry_change(uuid,uuid,bigint,jsonb,boolean)',
          'apply_entry_change', 5, true),
         ('public.list_account_entries(timestamp with time zone,integer)',
          'list_account_entries', 2, true)
)
select 'D. functions' as check_group,
       f.sig as object,
       case
         when p.oid is null then 'UNEXPECTED: function does not exist'
         when not p.prosecdef then 'UNEXPECTED: not security definer'
         when coalesce(p.proconfig, array[]::text[]) <> array['search_path=""']::text[]
           then 'UNEXPECTED: search_path is not exactly empty, got ' ||
                coalesce(p.proconfig::text, 'NULL')
         when has_function_privilege('anon', p.oid, 'EXECUTE')
           then 'UNEXPECTED: anon can execute'
         when has_function_privilege('public', p.oid, 'EXECUTE')
           then 'UNEXPECTED: public can execute'
         when has_function_privilege('authenticated', p.oid, 'EXECUTE') <> f.authenticated_exec
           then 'UNEXPECTED: authenticated execute should be ' || f.authenticated_exec::text
         else 'EXPECTED'
       end as verdict
  from funcs f
  left join pg_proc p
         on p.oid = to_regprocedure(f.sig)
 order by f.sig;

-- D2. Client-facing signatures (what supabase.rpc() can address).
select 'D2. rpc signatures' as check_group,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as object,
       case when p.prosecdef and coalesce(p.proconfig, array[]::text[]) = array['search_path=""']::text[]
            then 'EXPECTED' else 'UNEXPECTED' end as verdict
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('apply_entry_change', 'list_account_entries')
   and has_function_privilege('authenticated', p.oid, 'EXECUTE')
 order by p.proname;

-- ---------------------------------------------------------------------------
-- E. Anonymous access probe. `set local role` is only valid as a top-level
--    statement, so this is not inside a DO block or function. If the next two
--    statements return "permission denied for table account_entries", the anon
--    role has no read path — that error IS the expected result. If they return
--    "EXPECTED: anon was denied", the editor session simply could not switch
--    role; re-run as the postgres role to get the error form.
-- ---------------------------------------------------------------------------
set local role anon;
select 'E. anon probe' as check_group,
       'anon select on public.account_entries' as object,
       'UNEXPECTED: anon was NOT denied a read' as verdict
  from public.account_entries
 limit 1;
reset role;

-- E2. Same probe for the authenticated role with no JWT: RLS must hide (not
--     error on) every row, because authenticated has SELECT but the policy
--     compares auth.uid() = owner_id. Expect: 0 rows returned.
set local role authenticated;
select 'E2. rls with no identity' as check_group,
       'authenticated select count' as object,
       case when count(*) = 0 then 'EXPECTED: 0 rows without a JWT'
            else 'UNEXPECTED: ' || count(*) || ' rows visible without auth.uid()' end as verdict
  from public.account_entries;
reset role;

commit;
