import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncTransport, ApplyResult } from './sync-engine';
import type { OutboxRecord, Entry } from './storage';
/** The caller must bind this transport to one authenticated account for a sync run. */
export function makeSupabaseTransport(client:SupabaseClient,accountId:string):SyncTransport{
 return {async apply(change:OutboxRecord):Promise<ApplyResult>{
  if(change.accountId!==accountId)throw new Error('Account mismatch');
  const {data:{session},error:sessionError}=await client.auth.getSession();
  if(sessionError||session?.user.id!==accountId)throw new Error('Account session changed');
  const {data,error}=await client.rpc('apply_entry_change',{p_id:change.entryId,p_operation_id:change.operationId,p_expected_revision:change.expectedRevision,p_payload:change.entry??{},p_deleted:change.entry===null});
  if(error)throw error;const row=Array.isArray(data)?data[0]:undefined;
  if(!row||!Number.isSafeInteger(row.revision)||row.revision<0)throw new Error('Invalid server response');
  if(row.outcome==='applied'||row.outcome==='already_applied')return {outcome:row.outcome,revision:row.revision};
  if(row.outcome==='conflict')return {outcome:'conflict',revision:row.revision,entry:row.deleted?null:row.payload as Entry|null};
  throw new Error('Unknown sync response');
 }};
}
