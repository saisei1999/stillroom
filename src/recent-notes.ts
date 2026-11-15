export type RecentNote = { entryId:string; noteId:string };
export const RECENT_NOTE_LIMIT=30;
export function touchRecent(history:RecentNote[], item:RecentNote):RecentNote[]{return [item,...history.filter(old=>old.entryId!==item.entryId||old.noteId!==item.noteId)].slice(0,RECENT_NOTE_LIMIT)}
export function readRecent(scope:string):RecentNote[]{try{const data:unknown=JSON.parse(localStorage.getItem(`stillroom-recent-notes-v1:${scope}`)??'[]');if(!Array.isArray(data))return [];return data.filter((x):x is RecentNote=>!!x&&typeof x==='object'&&typeof x.entryId==='string'&&typeof x.noteId==='string').slice(0,RECENT_NOTE_LIMIT)}catch{return []}}
export function writeRecent(scope:string,history:RecentNote[]):void{try{localStorage.setItem(`stillroom-recent-notes-v1:${scope}`,JSON.stringify(history.slice(0,RECENT_NOTE_LIMIT)))}catch{/* Recent history is optional; never block the editor. */}}
