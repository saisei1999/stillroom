import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import DragHandle from '@tiptap/extension-drag-handle-react';

type Action = { title:string; hint:string; keys:string; run:(editor:Editor)=>void };
const actions:Action[]=[
 {title:'Text',hint:'Start writing',keys:'text paragraph',run:e=>{e.chain().focus().setParagraph().run()}},
 {title:'Heading 1',hint:'Large section heading',keys:'heading h1',run:e=>{e.chain().focus().setHeading({level:1}).run()}},
 {title:'Heading 2',hint:'Medium section heading',keys:'heading h2',run:e=>{e.chain().focus().setHeading({level:2}).run()}},
 {title:'Heading 3',hint:'Small section heading',keys:'heading h3',run:e=>{e.chain().focus().setHeading({level:3}).run()}},
 {title:'Bulleted list',hint:'Create a simple list',keys:'bullet list',run:e=>{e.chain().focus().toggleBulletList().run()}},
 {title:'Numbered list',hint:'Create a numbered list',keys:'number ordered list',run:e=>{e.chain().focus().toggleOrderedList().run()}},
 {title:'To-do list',hint:'Keep track with checkboxes',keys:'todo task checkbox',run:e=>{e.chain().focus().toggleTaskList().run()}},
 {title:'Quote',hint:'Capture a quotation',keys:'quote',run:e=>{e.chain().focus().toggleBlockquote().run()}},
 {title:'Code block',hint:'Write code',keys:'code',run:e=>{e.chain().focus().toggleCodeBlock().run()}},
 {title:'Divider',hint:'Separate sections',keys:'divider line',run:e=>{e.chain().focus().setHorizontalRule().run()}},
];
type Slash = {from:number;to:number;query:string;top:number;left:number};
export function BlockEditor({value,onChange}:{value:string;onChange:(value:string)=>void}){
 const callback=useRef(onChange);callback.current=onChange;
 const wrapper=useRef<HTMLDivElement>(null),slashRef=useRef<Slash|null>(null),indexRef=useRef(0);
 const [slash,setSlashState]=useState<Slash|null>(null),[active,setActiveState]=useState(0);
 const setSlash=(v:Slash|null)=>{slashRef.current=v;setSlashState(v)};
 const setActive=(v:number)=>{indexRef.current=v;setActiveState(v)};
 const matching=(s:Slash)=>actions.filter(a=>(a.title+' '+a.keys).toLowerCase().includes(s.query.toLowerCase()));
 const choose=(editor:Editor,action:Action)=>{const current=slashRef.current;if(current)editor.chain().focus().deleteRange({from:current.from,to:current.to}).run();setSlash(null);action.run(editor)};
 const editor=useEditor({extensions:[StarterKit.configure({link:{openOnClick:false}}),Markdown,Placeholder.configure({placeholder:'Type / for commands, or just start writing…'}),TaskList,TaskItem.configure({nested:true})],content:value,contentType:'markdown',editorProps:{attributes:{class:'notion-document',role:'textbox','aria-label':'Note document','aria-multiline':'true'},handleKeyDown(view,event){const s=slashRef.current;if(!s)return false;const options=matching(s);if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(options.length?(indexRef.current+(event.key==='ArrowDown'?1:-1)+options.length)%options.length:0);return true}if(event.key==='Enter'&&options.length){event.preventDefault();const e=editorRef.current;if(e)choose(e,options[indexRef.current]??options[0]);return true}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setSlash(null);return true}return false}},onUpdate:({editor})=>{callback.current(editor.getMarkdown());updateSlash(editor)},onSelectionUpdate:({editor})=>updateSlash(editor)});
 const editorRef=useRef(editor);editorRef.current=editor;
 function updateSlash(e:Editor){const {$from,empty}=e.state.selection;if(!empty){setSlash(null);return}const before=$from.parent.textBetween(0,$from.parentOffset,'\n','\ufffc');const match=before.match(/(?:^|\s)\/([^\s/]*)$/);if(!match){setSlash(null);return}const coords=e.view.coordsAtPos($from.pos);const box=wrapper.current?.getBoundingClientRect();if(!box)return;const from=$from.pos-match[1].length-1;const next={from,to:$from.pos,query:match[1],top:coords.bottom-box.top+6,left:Math.max(0,coords.left-box.left)};if(slashRef.current?.query!==next.query)setActive(0);setSlash(next)}
 useEffect(()=>()=>{slashRef.current=null},[]);
 if(!editor)return null;
 const options=slash?matching(slash):[];
 return <div className="rich-note-wrap" ref={wrapper}>
  <BubbleMenu editor={editor} className="format-bubble"><button type="button" aria-label="Bold" onMouseDown={e=>e.preventDefault()} onClick={()=>editor.chain().focus().toggleBold().run()}><b>B</b></button><button type="button" aria-label="Italic" onMouseDown={e=>e.preventDefault()} onClick={()=>editor.chain().focus().toggleItalic().run()}><i>I</i></button><button type="button" aria-label="Strikethrough" onMouseDown={e=>e.preventDefault()} onClick={()=>editor.chain().focus().toggleStrike().run()}><s>S</s></button><button type="button" aria-label="Inline code" onMouseDown={e=>e.preventDefault()} onClick={()=>editor.chain().focus().toggleCode().run()}>&lt;/&gt;</button><button type="button" aria-label="Add link" onMouseDown={e=>e.preventDefault()} onClick={()=>{const url=prompt('Link URL',editor.getAttributes('link').href??'https://');if(url===null)return;if(!url.trim()){editor.chain().focus().extendMarkRange('link').unsetLink().run();return}try{const parsed=new URL(url);if(parsed.protocol!=='http:'&&parsed.protocol!=='https:')throw Error();editor.chain().focus().extendMarkRange('link').setLink({href:parsed.href}).run()}catch{alert('Enter a valid http or https link.')}}}>↗</button></BubbleMenu>
  <div className="mobile-editor-tools" aria-label="Formatting"><button type="button" onClick={()=>editor.chain().focus().toggleBold().run()} aria-label="Bold"><b>B</b></button><button type="button" onClick={()=>editor.chain().focus().toggleItalic().run()} aria-label="Italic"><i>I</i></button><button type="button" onClick={()=>editor.chain().focus().toggleHeading({level:2}).run()} aria-label="Heading">H</button><button type="button" onClick={()=>editor.chain().focus().toggleBulletList().run()} aria-label="Bulleted list">• List</button><button type="button" onClick={()=>editor.chain().focus().toggleTaskList().run()} aria-label="To-do list">☑</button></div>
  <DragHandle editor={editor} className="note-drag-handle"><button type="button" aria-label="Drag to move block" title="Drag to move block">⠿</button></DragHandle>
  <EditorContent editor={editor}/>
  {slash&&<div className="slash-menu" role="listbox" aria-label="Insert a block" style={{top:slash.top,left:slash.left}}>{options.length?options.map((action,index)=><button type="button" role="option" aria-selected={active===index} key={action.title} onMouseDown={event=>event.preventDefault()} onMouseEnter={()=>setActive(index)} onClick={()=>choose(editor,action)}><strong>{action.title}</strong><small>{action.hint}</small></button>):<span>No matching blocks</span>}</div>}
 </div>;
}
