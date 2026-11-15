import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion, useSpring } from 'motion/react';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent } from '@dnd-kit/core';
import type { Entry } from './storage';
import { typeLabel } from './progress';
import { applyPendingMoves, clearResolvedMoves, type PendingMoves } from './focus-moves';
const baseStatuses=['On my radar','Planned','In progress','Completed','Paused','Dropped'];
function Poster({entry,children,pending}:{entry:Entry;children:ReactNode;pending:boolean}){
 const {attributes,listeners,setNodeRef,isDragging}=useDraggable({id:entry.id,disabled:pending});
 return <div ref={setNodeRef} className={'focus-draggable '+(isDragging?'is-dragging':'')} {...listeners} aria-label={`Drag ${entry.title} to a status; or use its status menu`} aria-describedby={attributes['aria-describedby']} aria-busy={pending}><div inert={pending||undefined}>{children}</div>{pending&&<span className="focus-saving" role="status">Saving…</span>}</div>;
}
function Column({status,children,count,dragging}:{status:string;children:ReactNode;count:number;dragging:boolean}){
 const {setNodeRef,isOver}=useDroppable({id:status});
 return <section ref={setNodeRef} className={'focus-column '+(isOver&&dragging?'is-drop-target':'')} data-density={count>1?'compact':'normal'}><div className="focus-column-header"><span className={'status-dot '+status.toLowerCase().replace(/\s+/g,'-')}/><h2>{status}</h2><span className="focus-column-count">{count}</span></div><div className="focus-column-cards">{children}{count===0&&<div className="focus-column-empty">{dragging?'Drop here':'No entries yet'}</div>}</div></section>;
}
function PosterPreview({entry}:{entry:Entry}){
 return <div className={'cover focus-drag-preview '+entry.color} aria-hidden="true"><span className="cover-index">{typeLabel(entry.type).toUpperCase()}</span>{entry.artworkUrl&&<img className="cover-image" src={entry.artworkUrl} alt="" referrerPolicy="no-referrer"/>}<div className="cover-details"><h2>{entry.title}</h2><div className="status">{entry.status}</div></div></div>;
}
export function FocusBoard({entries,renderCard,onMove}:{entries:Entry[];renderCard:(item:Entry,index:number)=>ReactNode;onMove:(id:string,status:string)=>Promise<boolean>}){
 const [activeId,setActiveId]=useState<string|null>(null),[pending,setPending]=useState<PendingMoves>({});
 const reduced=useReducedMotion();
 const tilt=useSpring(0,{stiffness:200,damping:15,mass:.55});
 const lastMovement=useRef<{x:number;time:number}|null>(null), tiltTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 useEffect(()=>()=>{if(tiltTimer.current)clearTimeout(tiltTimer.current)},[]);
 const move=(event:DragMoveEvent)=>{if(reduced)return;const now=performance.now(),prev=lastMovement.current;if(prev){const elapsed=Math.max(8,now-prev.time);const velocity=(event.delta.x-prev.x)/elapsed;tilt.set(Math.max(-9,Math.min(9,velocity*5)))}lastMovement.current={x:event.delta.x,time:now};if(tiltTimer.current)clearTimeout(tiltTimer.current);tiltTimer.current=setTimeout(()=>tilt.set(0),90)};
 useEffect(()=>{setPending(old=>clearResolvedMoves(entries,old))},[entries,pending]);
 const resetTilt=()=>{tilt.set(0);lastMovement.current=null;if(tiltTimer.current)clearTimeout(tiltTimer.current)};
 const sensors=useSensors(useSensor(MouseSensor,{activationConstraint:{distance:8}}),useSensor(TouchSensor,{activationConstraint:{delay:250,tolerance:8}}));
 const displayed=applyPendingMoves(entries,pending);
 const active=displayed.find(item=>item.id===activeId);
 const statuses=[...baseStatuses,...Array.from(new Set(entries.map(item=>item.status))).filter(status=>!baseStatuses.includes(status))];
 const end=(event:DragEndEvent)=>{const id=String(event.active.id),status=event.over?.id===undefined?null:String(event.over.id),entry=entries.find(item=>item.id===id);resetTilt();if(entry&&status&&statuses.includes(status)&&status!==entry.status&&!pending[id]){setPending(old=>({...old,[id]:{status,saved:false}}));void onMove(id,status).then(ok=>setPending(old=>{if(!old[id]||old[id].status!==status)return old;const next={...old};if(ok)next[id]={status,saved:true};else delete next[id];return next})).catch(()=>setPending(old=>{const next={...old};delete next[id];return next}))}setActiveId(null)};
 return <><p className="focus-board-hint">Drag a poster to change its status, or use its status menu.</p><DndContext sensors={sensors} onDragStart={event=>{tilt.jump(0);lastMovement.current=null;setActiveId(String(event.active.id))}} onDragMove={move} onDragCancel={()=>{resetTilt();setActiveId(null)}} onDragEnd={end}><div className="focus-board" aria-label="Focus board">{statuses.map(status=>{const cards=displayed.filter(item=>item.status===status);return <Column key={status} status={status} count={cards.length} dragging={!!activeId}>{cards.map(item=><Poster key={item.id} entry={item} pending={!!pending[item.id]}>{renderCard(item,entries.findIndex(x=>x.id===item.id))}</Poster>)}</Column>})}</div><DragOverlay dropAnimation={null}>{active?<motion.div className="focus-drag-motion" style={reduced?undefined:{rotate:tilt}}><PosterPreview entry={active}/></motion.div>:null}</DragOverlay></DndContext></>;
}

