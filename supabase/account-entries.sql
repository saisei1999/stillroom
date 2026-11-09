create table public.account_entries (
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 id uuid not null,
 payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 262144),
 updated_at timestamptz not null default now(),
 primary key (owner_id,id)
);
alter table public.account_entries enable row level security;
revoke all on public.account_entries from public, anon, authenticated;
grant select, insert, update, delete on public.account_entries to authenticated;
create policy "account_select_own" on public.account_entries for select to authenticated using ((select auth.uid()) = owner_id);
create policy "account_insert_own" on public.account_entries for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "account_update_own" on public.account_entries for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "account_delete_own" on public.account_entries for delete to authenticated using ((select auth.uid()) = owner_id);
