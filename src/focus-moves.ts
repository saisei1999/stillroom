import type { Entry } from './storage';
export type PendingMove = {status:string; saved:boolean};
export type PendingMoves = Record<string,PendingMove>;
/** Reflect a pending change without mutating the last durable library snapshot. */
export function applyPendingMoves(entries:Entry[],pending:PendingMoves):Entry[]{
 return entries.map(entry=>pending[entry.id]?{...entry,status:pending[entry.id].status}:entry);
}
/** Keep a successful move visible until the saved snapshot actually catches up. */
export function clearResolvedMoves(entries:Entry[],pending:PendingMoves):PendingMoves{
 let result=pending;
 for(const [id,move] of Object.entries(pending)){
  if(!move.saved)continue;
  const entry=entries.find(item=>item.id===id);
  if(!entry||entry.status===move.status){if(result===pending)result={...pending};delete result[id]}
 }
 return result;
}

