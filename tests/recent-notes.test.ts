import { describe, expect, it } from 'vitest';
import { touchRecent } from '../src/recent-notes';
describe('recent notes',()=>{
 it('only records accessed notes and moves an accessed note to the top',()=>{const a={entryId:'a',noteId:'one'},b={entryId:'b',noteId:'two'};expect(touchRecent([a,b],b)).toEqual([b,a]);expect(touchRecent([],a)).toEqual([a])});
 it('caps history and distinguishes notes with the same id in different entries',()=>{const items=Array.from({length:30},(_,i)=>({entryId:String(i),noteId:'general'}));const next=touchRecent(items,{entryId:'new',noteId:'general'});expect(next).toHaveLength(30);expect(next[0].entryId).toBe('new');expect(next.some(item=>item.entryId==='29')).toBe(false)});
});
