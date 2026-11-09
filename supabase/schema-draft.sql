-- Account-owned entries. Apply only after reviewing and testing in the target project.
create table public.library_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  payload jsonb not null,
  revision bigint not null default 1,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.library_entries enable row level security;
revoke all on public.library_entries from anon, authenticated;
-- Reads are isolated by the authenticated account. Writes go through the revision-checked function.
grant select on public.library_entries to authenticated;
create policy "read own entries" on public.library_entries for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.save_library_entry(p_id uuid, p_expected_revision bigint, p_payload jsonb, p_deleted boolean)
returns public.library_entries
language plpgsql security invoker set search_path = '' as $$
declare result public.library_entries;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  raise exception 'Sync write RPC is not enabled until authorization and conflict behavior are fully tested';
end $$;
-- Deliberately not granted: the client must not enable sync before write authorization,
-- offline queues, conflict handling, account switching and migration are complete.
revoke all on function public.save_library_entry(uuid, bigint, jsonb, boolean) from public, anon, authenticated;
