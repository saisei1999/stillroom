import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { listEntries, putEntry, deleteEntry, makeBackup, parseBackup, replaceEntries, type Entry } from '../src/storage';
const sample:Entry={id:'one',title:'Example',type:'Book',status:'Planned',color:'blue',progress:'',tags:['Favorite'],notes:'Some notes',createdAt:'2026-01-01T00:00:00.000Z'};
describe('local library',()=>{
 it('saves, updates, exports, restores and deletes entries',async()=>{await putEntry(sample);expect(await listEntries()).toEqual([sample]);await putEntry({...sample,status:'Completed'});const entries=await listEntries();expect(entries[0].status).toBe('Completed');const backup=makeBackup(entries);await deleteEntry('one');expect(await listEntries()).toEqual([]);await replaceEntries(parseBackup(backup));expect(await listEntries()).toEqual(entries);await deleteEntry('one');expect(await listEntries()).toEqual([])});
 it('rejects invalid and duplicate backup entries',()=>{expect(()=>parseBackup('{"format":"stillroom","version":2,"entries":[]}')).toThrow();expect(()=>parseBackup(JSON.stringify({format:'stillroom',version:1,entries:[sample,sample]}))).toThrow()});
 it('preserves artwork links in backups',()=>{const entry={...sample,artworkUrl:'https://example.com/poster.jpg'};expect(parseBackup(makeBackup([entry]))).toEqual([entry]);expect(()=>parseBackup(makeBackup([{...entry,artworkUrl:42} as unknown as Entry]))).toThrow()});
 it('round-trips product fields in a backup',()=>{const product:Entry={...sample,type:'Product',status:'Using',productUrl:'https://example.com/bag',price:'49.99',priority:'High'};expect(parseBackup(makeBackup([product]))).toEqual([product]);expect(()=>parseBackup(makeBackup([{...product,price:42} as unknown as Entry]))).toThrow()});
});
