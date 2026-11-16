-- Proposed migration, not yet applied. Limits Stillroom to 1,000 credits
-- in any rolling 31-day period, and each account to 100 credits. External Watchmode usage is not included.
begin;
create table public.stillroom_watchmode_budget_events (
  id bigint generated always as identity primary key,
  account_id uuid not null,
  reserved_at timestamptz not null default clock_timestamp()
);
create index stillroom_watchmode_budget_events_time on public.stillroom_watchmode_budget_events(reserved_at);
alter table public.stillroom_watchmode_budget_events enable row level security;
revoke all on public.stillroom_watchmode_budget_events from public, anon, authenticated;
create function public.stillroom_take_watchmode_budget()
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare account uuid := auth.uid();
begin
  if account is null or coalesce(auth.jwt()->>'is_anonymous', 'false') = 'true' then return false; end if;
  perform pg_advisory_xact_lock(814191, 190621);
  delete from public.stillroom_watchmode_budget_events where reserved_at <= clock_timestamp() - interval '31 days';
  if (select count(*) from public.stillroom_watchmode_budget_events) >= 500 then return false; end if;
  if (select count(*) from public.stillroom_watchmode_budget_events where account_id = account) >= 50 then return false; end if;
  insert into public.stillroom_watchmode_budget_events(account_id) values (account);
  return true;
end;
$$;
revoke all on function public.stillroom_take_watchmode_budget() from public;
grant execute on function public.stillroom_take_watchmode_budget() to authenticated;
commit;
