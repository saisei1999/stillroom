import { describe,it,expect,vi } from 'vitest';
import { pushPending } from '../src/sync-engine';
import type { OutboxRecord } from '../src/storage';
const a:OutboxRecord={accountId:'a',entryId:'1',operationId:'op',expectedRevision:0,entry:null};
describe('sync processing',()=>{
 it('acknowledges only accepted writes',async()=>{const ack=vi.fn();const report=await pushPending('a',{pending:async()=>[a],acknowledge:ack},{apply:async()=>({outcome:'applied',revision:1})});expect(report.synced).toBe(1);expect(ack).toHaveBeenCalledWith('a','1','op',1)});
 it('retains conflicts and never acknowledges them',async()=>{const ack=vi.fn();const report=await pushPending('a',{pending:async()=>[a],acknowledge:ack},{apply:async()=>({outcome:'conflict',revision:2,entry:null})});expect(report.conflicts).toHaveLength(1);expect(ack).not.toHaveBeenCalled()});
 it('leaves pending writes intact on network failure',async()=>{const ack=vi.fn();const report=await pushPending('a',{pending:async()=>[a],acknowledge:ack},{apply:async()=>{throw Error('offline')}});expect(report.failed).toBe(true);expect(ack).not.toHaveBeenCalled()});
 it('rejects a queue containing another account',async()=>{await expect(pushPending('b',{pending:async()=>[a],acknowledge:vi.fn()},{apply:vi.fn()})).rejects.toThrow()});
});
