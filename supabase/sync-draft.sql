-- DRAFT ONLY: do not apply until migration and authorization tests pass.
-- This replaces direct client writes with revision-checked, idempotent operations.
begin;
alter table public.account_entries add column revision bigint not null default 1;
alter table public.account_entries add column deleted boolean not null default false;
revoke insert, update, delete on public.account_entries from authenticated;
create table public.sync_operations (
 owner_id uuid not null references auth.users(id) on delete cascade,
 operation_id uuid not null,
 entry_id uuid not null,
 revision bigint not null,
 primary key (owner_id,operation_id)
);
alter table public.sync_operations enable row level security;
revoke all on public.sync_operations from public, anon, authenticated;
create or replace function public.apply_entry_change(p_id uuid, p_operation_id uuid, p_expected_revision bigint, p_payload jsonb, p_deleted boolean)
returns table(outcome text, revision bigint, payload jsonb, deleted boolean)
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); previous public.sync_operations%rowtype; current_row public.account_entries%rowtype; next_revision bigint;
begin
 if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if p_id is null or p_operation_id is null or p_expected_revision is null or p_expected_revision<0 or p_deleted is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or pg_column_size(p_payload)>262144 then raise exception 'Invalid operation'; end if;
 -- Lock the operation id and entry, in a stable order, including when no row exists.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text || ':op:' || p_operation_id::text,0));
 select * into previous from public.sync_operations where owner_id=uid and operation_id=p_operation_id;
 if found then
   if previous.entry_id<>p_id then raise exception 'Operation ID reused for another entry'; end if;
   select * into current_row from public.account_entries where owner_id=uid and id=p_id;
   return query select 'already_applied'::text,previous.revision,current_row.payload,current_row.deleted; return;
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text || ':entry:' || p_id::text,0));
 select * into current_row from public.account_entries where owner_id=uid and id=p_id for update;
 if not found then
   if p_expected_revision<>0 then return query select 'conflict'::text,0::bigint,null::jsonb,false; return; end if;
   next_revision:=1;
   insert into public.account_entries(owner_id,id,payload,revision,deleted,updated_at) values(uid,p_id,p_payload,next_revision,p_deleted,now());
 else
   if current_row.revision<>p_expected_revision then return query select 'conflict'::text,current_row.revision,current_row.payload,current_row.deleted; return; end if;
   next_revision:=current_row.revision+1;
   update public.account_entries set payload=p_payload,revision=next_revision,deleted=p_deleted,updated_at=now() where owner_id=uid and id=p_id;
 end if;
 insert into public.sync_operations(owner_id,operation_id,entry_id,revision) values(uid,p_operation_id,p_id,next_revision);
 return query select 'applied'::text,next_revision,p_payload,p_deleted;
end $$;
revoke all on function public.apply_entry_change(uuid,uuid,bigint,jsonb,boolean) from public,anon;
grant execute on function public.apply_entry_change(uuid,uuid,bigint,jsonb,boolean) to authenticated;
commit;
