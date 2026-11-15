import { describe, expect, it } from 'vitest';
import { parseProgress, formatProgress, typeLabel } from '../src/progress';
import { sanitizeEntry } from '../src/storage';
import { parseEntry } from '../src/sync-core';
const base={id:'entry-1',title:'Example',type:'TV / Anime',status:'Planned',color:'blue',progress:'Episode 3',tags:[],notes:'',createdAt:'2026-01-01'};
describe('media progress',()=>{
 it('preserves structured progress and legacy text through sync and backup validation',()=>{const e={...base,progressDetail:{kind:'episodes' as const,total:3,completed:[1,3]}};expect(sanitizeEntry(e)).toEqual(e);expect(parseEntry(e)).toEqual(e);expect(formatProgress(e)).toBe('2 / 3 episodes');});
 it('rejects malformed progress instead of silently losing data',()=>{const e={...base,progressDetail:{kind:'episodes',total:2,completed:[3]}};expect(sanitizeEntry(e)).toBeUndefined();expect(()=>parseEntry(e)).toThrow();expect(parseProgress({kind:'movie',digits:'1299'})).toBeUndefined();});
 it('keeps legacy entries readable and labels shows without changing their stored type',()=>{expect(sanitizeEntry(base)).toEqual(base);expect(formatProgress(base)).toBe('Episode 3');expect(typeLabel(base.type)).toBe('TV Show');});
 it('round-trips multiple seasons without losing their independent completion marks',()=>{const detail={kind:'episodes' as const,total:2,completed:[1],seasons:[{id:'s1',name:'Season 1',total:2,completed:[1]},{id:'s2',name:'Season 2',total:3,completed:[2,3]}]};const e={...base,progressDetail:detail};expect(sanitizeEntry(e)).toEqual(e);expect(parseEntry(e)).toEqual(e);expect(formatProgress(e)).toBe('3 / 5 episodes');});
 it('rejects invalid seasons and preserves legacy single-season data',()=>{expect(parseProgress({kind:'episodes',total:2,completed:[2]})).toEqual({kind:'episodes',total:2,completed:[2]});expect(parseProgress({kind:'episodes',total:2,completed:[1],seasons:[{id:'s1',name:'Season 1',total:2,completed:[2]}]})).toBeUndefined();expect(parseProgress({kind:'episodes',total:2,completed:[1],seasons:[{id:'s1',name:'Season 1',total:2,completed:[1]},{id:'s1',name:'Season 2',total:1,completed:[]}]})).toBeUndefined();});
});


