import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Entry } from './storage';
type NoteTarget={entry:Entry;id:string;title:string;x:number;y:number};
export function useNoteContext(onOpen:(entry:Entry,id:string)=>void,onOpenEntry:(entry:Entry)=>void){
 const [menu,setMenu]=useState<NoteTarget|null>(null);const ref=useRef<HTMLDivElement>(null),anchor=useRef<HTMLElement|null>(null);
 const close=(restore=false)=>{setMenu(null);if(restore)anchor.current?.focus()};
 const show=(entry:Entry,id:string,title:string,x:number,y:number,source:HTMLElement)=>{anchor.current=source;setMenu({entry,id,title,x:Math.max(8,Math.min(x,window.innerWidth-208)),y:Math.max(8,Math.min(y,window.innerHeight-120))})};
 useEffect(()=>{if(!menu)return;ref.current?.querySelector<HTMLButtonElement>('button')?.focus();const dismiss=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node))close()};const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close(true)}else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();const items=Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button')??[]),i=items.indexOf(document.activeElement as HTMLButtonElement);items[(i+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus()}};document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',key)}},[menu]);
 const bind=(entry:Entry,id:string,title:string)=>({onContextMenu:(e:React.MouseEvent<HTMLButtonElement>)=>{e.preventDefault();show(entry,id,title,e.clientX,e.clientY,e.currentTarget)},onKeyDown:(e:React.KeyboardEvent<HTMLButtonElement>)=>{if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();const r=e.currentTarget.getBoundingClientRect();show(entry,id,title,r.right,r.top,e.currentTarget)}},'aria-haspopup':'menu' as const});
 const element=menu&&createPortal(<div ref={ref} className="view-context-menu" role="menu" aria-label={`Options for ${menu.title}`} style={{left:menu.x,top:menu.y}}><button role="menuitem" type="button" onClick={()=>{onOpen(menu.entry,menu.id);close()}}>Open note</button><button role="menuitem" type="button" onClick={()=>{onOpenEntry(menu.entry);close()}}>Open {menu.entry.title}</button></div>,document.body);
 return {bind,element};
}

