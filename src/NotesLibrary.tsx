import { useState } from 'react';
import type { Entry } from './storage';
export function NotesLibrary({entries,onOpen}:{entries:Entry[];onOpen:(entry:Entry,noteId:string)=>void}){
 const [query,setQuery]=useState('');
 const notes=entries.flatMap(entry=>[...(entry.notes.trim()?[{entry,id:'general',title:'General notes',body:entry.notes}]:[]),...(entry.noteSections??[]).map(note=>({entry,id:note.id,title:note.title||'Untitled note',body:note.body}))]);
 const shown=notes.filter(note=>`${note.title} ${note.body} ${note.entry.title}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 return <section className="notes-library"><div className="title-row"><h1>Notes <span>{String(shown.length).padStart(2,'0')}</span></h1></div><div className="notes-library-search"><label><span className="sr-only">Search notes</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search notes or entries"/></label></div>{shown.length?<div className="notes-library-grid">{shown.map(note=><button type="button" key={note.entry.id+':'+note.id} className="notes-library-card" onClick={()=>onOpen(note.entry,note.id)}><strong>{note.title}</strong><span>{note.body.replace(/[#*_`>\[\]]/g,'').trim()||'Empty note'}</span><small>{note.entry.title} · {note.entry.type}</small></button>)}</div>:<p className="empty">{query?'No notes match this search.':'Notes you add to an entry will appear here.'}</p>}</section>;
}

