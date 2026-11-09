import type { Entry, OutboxRecord } from './storage';
export type ApplyResult={outcome:'applied'|'already_applied';revision:number}|{outcome:'conflict';revision:number;entry:Entry|null};
export interface SyncTransport { apply(change:OutboxRecord):Promise<ApplyResult> }
export interface SyncQueue { pending(accountId:string):Promise<OutboxRecord[]>; acknowledge(accountId:string,entryId:string,operationId:string,revision:number):Promise<void> }
export type SyncReport={synced:number;conflicts:Array<{change:OutboxRecord;revision:number;server:Entry|null}>;failed:boolean};
/** Processes only the supplied account's durable queue; conflicts remain queued. */
export async function pushPending(accountId:string,queue:SyncQueue,transport:SyncTransport):Promise<SyncReport>{
 const report:SyncReport={synced:0,conflicts:[],failed:false};
 for(const change of await queue.pending(accountId)){
  if(change.accountId!==accountId)throw new Error('Queue returned another account');
  try{const result=await transport.apply(change);if(result.outcome==='conflict'){report.conflicts.push({change,revision:result.revision,server:result.entry});continue}await queue.acknowledge(accountId,change.entryId,change.operationId,result.revision);report.synced++}catch{report.failed=true;break}
 }
 return report;
}
