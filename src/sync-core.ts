import type { Entry } from './storage';
/** An account-scoped operation. Deletions remain tombstones until acknowledged. */
export type PendingChange={accountId:string;entryId:string;operationId:string;expectedRevision:number;entry:Entry|null};
export type ServerEntry={id:string;revision:number;entry:Entry|null};
export type SyncDecision = {kind:'push';change:PendingChange} | {kind:'accept';server:ServerEntry} | {kind:'conflict';local:PendingChange;server:ServerEntry};
/** Never replace an unacknowledged local edit with a different remote revision. */
export function reconcile(local:PendingChange|undefined,server:ServerEntry):SyncDecision {
 if(!local)return {kind:'accept',server};
 if(local.entryId!==server.id)throw new Error('Entry mismatch');
 if(local.expectedRevision===server.revision)return {kind:'push',change:local};
 return {kind:'conflict',local,server};
}
export function belongsToAccount(change:PendingChange,accountId:string):boolean{return change.accountId===accountId}
