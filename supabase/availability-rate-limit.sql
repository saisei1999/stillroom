-- Additive, global provider quota guard. No existing entry tables are modified.
begin;
create table public.stillroom_availability_budget (
  id boolean primary key default true check (id),
  window_start timestamptz not null default clock_timestamp(),
  used integer not null default 0 check (used between 0 and 121)
);
alter table public.stillroom_availability_budget enable row level security;
revoke all on public.stillroom_availability_budget from public, anon, authenticated;
insert into public.stillroom_availability_budget(id) values (true) on conflict do nothing;
create function public.stillroom_take_availability_budget()
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare current_used integer;
begin
  update public.stillroom_availability_budget
    set used = case when clock_timestamp() - window_start >= interval '1 minute' then 1 else least(used + 1, 121) end,
        window_start = case when clock_timestamp() - window_start >= interval '1 minute' then clock_timestamp() else window_start end
    where id = true returning used into current_used;
  return coalesce(current_used <= 120, false);
end;
$$;
revoke all on function public.stillroom_take_availability_budget() from public;
grant execute on function public.stillroom_take_availability_budget() to anon, authenticated;
commit;
