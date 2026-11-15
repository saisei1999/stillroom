import React, {useState} from 'react';
import type {ProgressDetail, ProgressSeason} from './progress';
type NodeProgress = Extract<ProgressDetail,{kind:'episodes'|'chapters'}>;
export function NodeProgressEditor({kind,value,onChange}:{kind:'episodes'|'chapters';value?:NodeProgress;onChange:(v:NodeProgress)=>void}){
 const unit=kind==='episodes'?'episode':'chapter';
 const current=value??{kind,total:0,completed:[]};
 const seasons=kind==='episodes'?(current.seasons??[{id:'season-1',name:'Season 1',total:current.total,completed:current.completed}]):[];
 const [selected,setSelected]=useState('season-1'),[amount,setAmount]=useState(''),[removing,setRemoving]=useState(false);
 const season=seasons.find(s=>s.id===selected)??seasons[0];
 const nodes=season??current;
 const updateNodes=(total:number,completed:number[])=>{if(kind==='chapters'){onChange({kind,total,completed});return}const updated=seasons.map(s=>s.id===season.id?{...s,total,completed}:s);onChange({kind:'episodes',total:updated[0].total,completed:updated[0].completed,seasons:updated})};
 const addNodes=()=>{const count=Number(amount);if(!Number.isInteger(count)||count<1||count>500-nodes.total)return;updateNodes(nodes.total+count,nodes.completed);setAmount('')};
 const removeNode=(n:number)=>{if(nodes.completed.includes(n)&&!window.confirm(`Remove completed ${unit} ${n}? Its completion mark will be lost.`))return;updateNodes(nodes.total-1,nodes.completed.filter(x=>x!==n).map(x=>x>n?x-1:x));};
 const addSeason=()=>{if(seasons.length>=100)return;let index=1;while(seasons.some(s=>s.name===`Season ${index}`))index++;const next:ProgressSeason={id:crypto.randomUUID(),name:`Season ${index}`,total:0,completed:[]};const updated=[...seasons,next];onChange({kind:'episodes',total:updated[0].total,completed:updated[0].completed,seasons:updated});setSelected(next.id);setRemoving(false)};
 const removeSeason=()=>{if(seasons.length<=1)return;if(!window.confirm(`Remove ${season.name} and its ${season.total} episodes?`))return;const updated=seasons.filter(s=>s.id!==season.id);onChange({kind:'episodes',total:updated[0].total,completed:updated[0].completed,seasons:updated});setSelected(updated[0].id);setRemoving(false)};
 return <div className="node-tracker">
 {kind==='episodes'&&<div className="season-controls"><label><span className="sr-only">Season</span><select aria-label="Season" value={season.id} onChange={e=>{setSelected(e.target.value);setRemoving(false)}}>{seasons.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><button type="button" onClick={addSeason} disabled={seasons.length>=100}>+ Season</button>{seasons.length>1&&<button type="button" onClick={removeSeason} aria-label={`Remove ${season.name}`}>Remove</button>}</div>}
 <div className="progress-summary">{nodes.completed.length} / {nodes.total} {kind} completed</div>
 {nodes.total>0&&<div className="progress-nodes">{Array.from({length:nodes.total},(_,i)=>i+1).map(n=><button type="button" key={n} className="progress-node" aria-label={removing?`Remove ${unit} ${n}`:`${unit} ${n}, ${nodes.completed.includes(n)?'completed':'not completed'}`} aria-pressed={removing?undefined:nodes.completed.includes(n)} onClick={()=>removing?removeNode(n):updateNodes(nodes.total,nodes.completed.includes(n)?nodes.completed.filter(x=>x!==n):[...nodes.completed,n])}>{n}{removing&&<span aria-hidden="true"> ×</span>}</button>)}</div>}
 <div className="node-actions"><label><span className="sr-only">Number of {kind} to add</span><input type="number" aria-label={`Number of ${kind} to add`} min="1" max={500-nodes.total} placeholder="Count" value={amount} onChange={e=>setAmount(e.target.value)} /></label><button type="button" disabled={!Number.isInteger(Number(amount))||Number(amount)<1||Number(amount)>500-nodes.total} onClick={addNodes}>Add {kind}</button>{nodes.total>0&&<button type="button" aria-pressed={removing} onClick={()=>setRemoving(!removing)}>{removing?'Done removing':'Remove'}</button>}</div>
 <small>{removing?`Select a ${unit} to remove it. Later numbers move down.`:`Tap ${kind === 'episodes' ? 'an' : 'a'} ${unit} to mark it complete.`}</small>
 </div>;
}

