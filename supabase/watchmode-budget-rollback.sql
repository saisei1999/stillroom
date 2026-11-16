-- Use only after disabling the Watchmode function path; removes quota state.
begin;
drop function if exists public.stillroom_take_watchmode_budget();
drop table if exists public.stillroom_watchmode_budget_events;
commit;
