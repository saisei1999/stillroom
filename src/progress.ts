export type ProgressSeason = {id:string; name:string; total:number; completed:number[]};
export type ProgressDetail = {kind:'episodes'|'chapters'; total:number; completed:number[]; seasons?:ProgressSeason[]} | {kind:'movie'; digits:string} | {kind:'music'; album:string; completed:number; total:number};
const validCount=(x:unknown):x is number=>typeof x==='number'&&Number.isInteger(x)&&x>=0&&x<=500;
function validNodes(total:unknown,completed:unknown):completed is number[] {return validCount(total)&&Array.isArray(completed)&&completed.length<=500&&completed.every(x=>validCount(x)&&x>=1&&x<=total)&&new Set(completed).size===completed.length;}
export function parseProgress(value:unknown): ProgressDetail | undefined {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
 const v=value as Record<string,unknown>;
 if ((v.kind==='episodes'||v.kind==='chapters') && validNodes(v.total,v.completed)) {
  if(v.seasons===undefined)return {kind:v.kind,total:v.total as number,completed:[...v.completed]};
  if(v.kind!=='episodes'||!Array.isArray(v.seasons)||v.seasons.length<1||v.seasons.length>100)return undefined;
  const seasons:ProgressSeason[]=[];
  for(const item of v.seasons){if(!item||typeof item!=='object'||Array.isArray(item))return undefined;const s=item as Record<string,unknown>;if(typeof s.id!=='string'||!s.id.trim()||s.id.length>100||typeof s.name!=='string'||!s.name.trim()||s.name.length>60||!validNodes(s.total,s.completed))return undefined;seasons.push({id:s.id,name:s.name,total:s.total as number,completed:[...s.completed]});}
  if(new Set(seasons.map(s=>s.id)).size!==seasons.length||seasons[0].total!==v.total||JSON.stringify(seasons[0].completed)!==JSON.stringify(v.completed))return undefined;
  return {kind:'episodes',total:v.total as number,completed:[...v.completed],seasons};
 }
 if (v.kind==='movie' && typeof v.digits==='string' && /^[0-9_]{2}[0-5_][0-9_]$/.test(v.digits)) return {kind:'movie',digits:v.digits};
 if (v.kind==='music' && typeof v.album==='string' && v.album.length<=160 && validCount(v.completed) && validCount(v.total)) return {kind:'music',album:v.album,completed:v.completed,total:v.total};
 return undefined;
}
export const typeLabel=(type:string)=>type==='TV / Anime'?'TV Show':type;
export function formatProgress(entry:{progress:string;type?:string;progressDetail?:ProgressDetail}):string {
 const p=entry.progressDetail;if(!p)return entry.progress;
 const expected=entry.type==='TV / Anime'?'episodes':entry.type==='Book'||entry.type==='Manga'?'chapters':entry.type==='Movie'?'movie':entry.type==='Music'?'music':undefined;
 if(entry.type && p.kind!==expected)return entry.progress;
 if(p.kind==='movie')return p.digits==='____'?entry.progress:`${p.digits.slice(0,2)}:${p.digits.slice(2)}`.replaceAll('_','–');
 if(p.kind==='music')return `${p.album ? p.album+' · ' : ''}${p.completed} / ${p.total} tracks`;
 if(p.kind==='episodes'&&p.seasons){const completed=p.seasons.reduce((n,s)=>n+s.completed.length,0),total=p.seasons.reduce((n,s)=>n+s.total,0);return `${completed} / ${total} episodes`;}
 return `${p.completed.length} / ${p.total} ${p.kind}`;
}


