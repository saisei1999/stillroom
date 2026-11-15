import { NodeProgressEditor } from './NodeProgressEditor';
import React from 'react';
import type { ProgressDetail } from './progress';
export function ProgressEditor({type,value,legacy,onChange,onLegacy}:{type:string;value?:ProgressDetail;legacy:string;onChange:(value:ProgressDetail)=>void;onLegacy:(value:string)=>void}) {
 const kind=type==='TV / Anime'?'episodes':type==='Book'||type==='Manga'?'chapters':type==='Movie'?'movie':type==='Music'?'music':null;
 if(!kind)return <label><span>Progress</span><input placeholder="Add progress (optional)" value={legacy} maxLength={100} onChange={e=>onLegacy(e.target.value)}/></label>;
 const v=value?.kind===kind?value:undefined;
 return <div className="progress-property"><span className="property-label">Progress</span><div className="progress-editor">
 {legacy&&<div className="legacy-progress">Previous progress: {legacy}</div>}
 {(kind==='episodes'||kind==='chapters')&&<NodeProgressEditor key={kind} kind={kind} value={v && (v.kind==='episodes'||v.kind==='chapters')?v:undefined} onChange={onChange}/>}
 {kind==='movie'&&(()=>{const p=v?.kind==='movie'?v:{kind:'movie' as const,digits:'____'};return <><span className="progress-summary">Position · hours : minutes</span><div className="time-input">{[0,1,2,3].map(i=><React.Fragment key={i}>{i===2&&<span className="time-colon">:</span>}<input aria-label={['Hours tens','Hours ones','Minutes tens','Minutes ones'][i]} inputMode="numeric" maxLength={1} value={p.digits[i]==='_'?'':p.digits[i]} placeholder="0" onChange={e=>{const c=e.target.value.replace(/\D/g,'').slice(-1);if(i===2&&c&&Number(c)>5)return;const digits=p.digits.slice(0,i)+(c||'_')+p.digits.slice(i+1);onChange({kind:'movie',digits});if(c)(e.currentTarget.parentElement?.querySelectorAll('input')[i+1] as HTMLInputElement|undefined)?.focus()}}/></React.Fragment>)}</div><small>Use hours and minutes: 2 hours is 02:00.</small></>})()}
 {kind==='music'&&(()=>{const p=v?.kind==='music'?v:{kind:'music' as const,album:'',completed:0,total:0};return <><label className="music-album">Album<input aria-label="Album title" placeholder="Album title" maxLength={160} value={p.album} onChange={e=>onChange({...p,album:e.target.value})}/></label><div className="music-tracks"><input aria-label="Tracks listened" type="number" min="0" max="500" value={p.completed} onChange={e=>onChange({...p,completed:Math.max(0,Math.min(500,Number(e.target.value)||0))})}/><span>/</span><input aria-label="Total tracks" type="number" min="0" max="500" value={p.total} onChange={e=>onChange({...p,total:Math.max(0,Math.min(500,Number(e.target.value)||0))})}/><span>tracks</span></div></>})()}
 </div></div>;
}

