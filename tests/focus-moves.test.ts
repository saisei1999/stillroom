import { describe, expect, it } from 'vitest';
import { applyPendingMoves, clearResolvedMoves, type PendingMoves } from '../src/focus-moves';
import type { Entry } from '../src/storage';
const entry:Entry={id:'a',title:'Film',type:'Movie',status:'Planned',color:'blue',progress:'',tags:['Focus'],notes:'',createdAt:'2026-01-01'};
describe('Focus move reconciliation',()=>{
 it('shows the destination immediately without changing the durable snapshot',()=>{const pending:PendingMoves={a:{status:'In progress',saved:false}};expect(applyPendingMoves([entry],pending)[0].status).toBe('In progress');expect(entry.status).toBe('Planned');expect(clearResolvedMoves([entry],pending)).toEqual(pending)});
 it('keeps a saved move visible until the refreshed snapshot catches up',()=>{const pending:PendingMoves={a:{status:'Completed',saved:true}};expect(clearResolvedMoves([entry],pending)).toEqual(pending);expect(clearResolvedMoves([{...entry,status:'Completed'}],pending)).toEqual({})});
 it('does not wait for an item that disappears from the filtered snapshot after saving',()=>{expect(clearResolvedMoves([],{a:{status:'Completed',saved:true}})).toEqual({})});
});

