import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { listEntries, putEntry, deleteEntry, makeBackup, parseBackup, replaceEntries, type Entry } from '../src/storage';
const sample:Entry={id:'one',title:'Example',type:'Book',status:'Planned',color:'blue',progress:'',tags:['Favorite'],notes:'Some notes',createdAt:'2026-01-01T00:00:00.000Z'};
describe('local library',()=>{
 it('saves, updates, exports, restores and deletes entries',async()=>{await putEntry(sample);expect(await listEntries()).toEqual([sample]);await putEntry({...sample,status:'Completed'});const entries=await listEntries();expect(entries[0].status).toBe('Completed');const backup=makeBackup(entries);await deleteEntry('one');expect(await listEntries()).toEqual([]);await replaceEntries(parseBackup(backup));expect(await listEntries()).toEqual(entries);await deleteEntry('one');expect(await listEntries()).toEqual([])});
 it('rejects invalid and duplicate backup entries',()=>{expect(()=>parseBackup('{"format":"stillroom","version":2,"entries":[]}')).toThrow();expect(()=>parseBackup(JSON.stringify({format:'stillroom',version:1,entries:[sample,sample]}))).toThrow()});
});
