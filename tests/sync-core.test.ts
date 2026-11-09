import { describe, expect, it } from 'vitest';
import { reconcile, belongsToAccount, type PendingChange } from '../src/sync-core';
const pending:PendingChange={accountId:'a',entryId:'one',operationId:'op1',expectedRevision:3,entry:null};
describe('sync conflict boundaries',()=>{
 it('preserves local work as a conflict if a remote revision changed',()=>{const result=reconcile(pending,{id:'one',revision:4,entry:null});expect(result.kind).toBe('conflict');if(result.kind==='conflict')expect(result.local).toEqual(pending)});
 it('only pushes when the expected revision matches',()=>{expect(reconcile(pending,{id:'one',revision:3,entry:null}).kind).toBe('push')});
 it('accepts remote data only without pending local work',()=>{expect(reconcile(undefined,{id:'one',revision:3,entry:null}).kind).toBe('accept')});
 it('keeps pending work scoped to its account',()=>{expect(belongsToAccount(pending,'a')).toBe(true);expect(belongsToAccount(pending,'b')).toBe(false)});
 it('rejects accidental cross-entry comparisons',()=>{expect(()=>reconcile(pending,{id:'other',revision:3,entry:null})).toThrow()});
});
