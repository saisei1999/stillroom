import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { queueAccountChange, listPending, listAccountEntries } from '../src/storage';
describe('durable outbox',()=>{
 it('atomically records offline deletion and separates account queues',async()=>{const row={accountId:'test-a',entryId:'entry',revision:0,entry:null};const change={accountId:'test-a',entryId:'entry',operationId:'op',expectedRevision:0,entry:null};await queueAccountChange(row,change);expect(await listPending('test-a')).toContainEqual(change);expect(await listPending('test-b')).toEqual([]);expect(await listAccountEntries('test-a')).toContainEqual(row)});
 it('rejects mismatched account data before writing',async()=>{await expect(queueAccountChange({accountId:'x',entryId:'x',revision:0,entry:null},{accountId:'y',entryId:'x',operationId:'op',expectedRevision:0,entry:null})).rejects.toThrow();expect(await listPending('y')).toEqual([])});
});
import { acknowledgeChange } from '../src/storage';
it('does not erase a newer edit when an older request returns',async()=>{const r={accountId:'race',entryId:'entry',revision:2,entry:null};await queueAccountChange(r,{accountId:'race',entryId:'entry',operationId:'new',expectedRevision:2,entry:null});await acknowledgeChange('race','entry','old',3);expect(await listPending('race')).toEqual([{accountId:'race',entryId:'entry',operationId:'new',expectedRevision:3,entry:null}]);expect((await listAccountEntries('race'))[0].revision).toBe(3)});
import { stageLocalImport, putEntry, listEntries } from '../src/storage';
it('stages a local import without removing the original library',async()=>{const item={id:'copy-test',title:'Original',type:'Book',status:'Planned',color:'blue',progress:'',tags:[],notes:'',createdAt:'2026-01-01'};await putEntry(item);expect(await stageLocalImport('import-test')).toBeGreaterThan(0);expect((await listEntries()).some(x=>x.id==='copy-test')).toBe(true);expect((await listPending('import-test')).some(x=>x.entryId==='copy-test')).toBe(true)});
