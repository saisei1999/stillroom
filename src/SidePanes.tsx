import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Entry } from './sync-core';
import { EntryPane } from './EntryPane';
import { BlockEditor } from './BlockEditor';

export type SidePaneRef = { key: string; kind: 'entry' | 'note'; entryId: string; noteId?: string };

type Props = {
  panes: SidePaneRef[];
  entries: Entry[];
  front: number;
  onFront: (index: number) => void;
  onClose: (key: string) => void;
  onSave: (entryId: string, patch: Partial<Entry>) => Promise<boolean>;
  onDelete: (entryId: string) => void;
  onDirty: (key: string, dirty: boolean) => void;
  dirtyKeys: Record<string, boolean>;
};

function NotePaneEditor({ entry, noteId, onSave, onDirty, registerSave }: { entry: Entry; noteId?: string; onSave: (patch: Partial<Entry>) => Promise<boolean>; onDirty: (dirty: boolean) => void; registerSave: (save: () => Promise<boolean>) => () => void }) {
  const general = noteId === 'general';
  const section = general ? undefined : entry.noteSections?.find(item => item.id === noteId);
  const source = { title: general ? 'General notes' : section?.title ?? '', body: general ? entry.notes : section?.body ?? '' };
  const [draft, setDraft] = useState(source);
  const [baseline, setBaseline] = useState(source);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const missing = !general && !section;
  const dirty = !missing && (draft.body !== baseline.body || draft.title !== baseline.title);
  const latest = useRef({ draft, baseline, entry, onSave, onDirty });
  latest.current = { draft, baseline, entry, onSave, onDirty };
  const pending = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    const previous = latest.current;
    const clean = previous.draft.body === previous.baseline.body && previous.draft.title === previous.baseline.title;
    if (clean) setDraft(source);
    setBaseline(source);
  }, [source.title, source.body]);
  useEffect(() => { latest.current.onDirty(dirty); }, [dirty]);

  const save = async (): Promise<boolean> => {
    if (pending.current) {
      const ok = await pending.current;
      if (!ok) return false;
      // A close can arrive while an older snapshot is saving. Flush the latest draft too.
      return saveRef.current();
    }
    if (missing) return true;
    const current = latest.current;
    const snapshot = current.draft;
    if (snapshot.body === current.baseline.body && snapshot.title === current.baseline.title) return true;
    setSaving(true);
    pending.current = (async () => {
      let ok = false;
      try {
        ok = general
          ? await current.onSave({ notes: snapshot.body })
          : await current.onSave({ noteSections: (current.entry.noteSections ?? []).map(item => item.id === noteId ? { ...item, title: snapshot.title.trim() || 'Untitled note', body: snapshot.body } : item) });
        if (ok) {
          latest.current.baseline = snapshot;
          setBaseline(snapshot);
        }
      } catch { /* Keep the draft open and offer retry. */ }
      finally { pending.current = null; setError(!ok); setSaving(false); }
      return ok;
    })();
    return pending.current;
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => registerSave(() => saveRef.current()), [registerSave]);
  useEffect(() => {
    if (!dirty || saving || error) return;
    const timer = window.setTimeout(() => { void saveRef.current().catch(() => {}); }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, baseline, dirty, saving, error]);
  const change = (patch: Partial<typeof draft>) => { setError(false); setDraft(old => ({ ...old, ...patch })); };

  if (missing) return <p className="side-pane-missing">This note is no longer in the entry.</p>;
  return <div className="note-side" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void saveRef.current().catch(() => {});
  }}>
    <p className="side-pane-eyebrow">{entry.type} · {entry.title}</p>
    {general ? <h2>General notes</h2> : <label className="note-side-title"><span className="sr-only">Note title</span>
      <input value={draft.title} maxLength={120} placeholder="Note title" onChange={event => change({ title: event.target.value })}/>
    </label>}
    <div className="note-side-body"><BlockEditor value={draft.body} onChange={body => change({ body })}/></div>
    <small className="note-autosave-status" role="status">{error ? 'Could not save. Your changes are still here.' : saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</small>
    {error && <button type="button" className="side-pane-open" onClick={() => { void saveRef.current().catch(() => {}); }}>Try again</button>}
  </div>;
}

/**
 * Side panes stack like sheets of paper: the front pane is fully visible and the
 * ones behind it peek out to the right, each shifted by the same amount.
 */
export function SidePanes({ panes, entries, front, onFront, onClose, onSave, onDelete, onDirty, dirtyKeys }: Props) {
  const saveHandlers = useRef(new Map<string, () => Promise<boolean>>());
  const closePane = async (pane: SidePaneRef) => {
    const flush = saveHandlers.current.get(pane.key);
    if (flush && !await flush()) return;
    onClose(pane.key);
  };
  const stackId = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tab = tabs.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (!tab || !tabs.current) return;
    const left = tab.offsetLeft, right = left + tab.offsetWidth;
    if (left < tabs.current.scrollLeft) tabs.current.scrollLeft = left;
    else if (right > tabs.current.scrollLeft + tabs.current.clientWidth) tabs.current.scrollLeft = right - tabs.current.clientWidth;
  }, [front, panes.length]);
  useEffect(() => {
    const target = tabs.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? stack.current?.querySelector<HTMLButtonElement>('.is-front .pane-close');
    target?.focus({preventScroll:true});
  }, [panes.length]);
  if (!panes.length) return null;
  const paneTitle = (pane: SidePaneRef) => {
    const entry = entries.find(item => item.id === pane.entryId);
    return pane.kind === 'entry' ? entry?.title ?? 'Missing entry'
      : pane.noteId === 'general' ? 'General notes'
      : entry?.noteSections?.find(note => note.id === pane.noteId)?.title || 'Untitled note';
  };
  return <div ref={stack} className={"pane-stack"+(panes.length>1?" has-tabs":"")} aria-label="Side panes" style={{ '--pane-peek': `${Math.min(panes.length - 1, 3) * 22}px` } as CSSProperties}>
    {panes.length>1&&<div className="pane-tabs" role="tablist" aria-label="Open right panes" ref={tabs}>
      {panes.map((pane, index) => <button key={pane.key} type="button" role="tab" id={stackId+'-tab-'+index} aria-controls={stackId+'-panel-'+index} aria-selected={index===front} tabIndex={index===front?0:-1} title={paneTitle(pane)} onClick={()=>onFront(index)} onKeyDown={event=>{
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        const next=event.key==='Home'?0:event.key==='End'?panes.length-1:(index+(event.key==='ArrowRight'?1:panes.length-1))%panes.length;
        onFront(next);
        tabs.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus({preventScroll:true});
      }}><span>{paneTitle(pane)}</span></button>)}
    </div>}
    {panes.map((pane, index) => {
      const entry = entries.find(candidate => candidate.id === pane.entryId);
      const depth = (front - index + panes.length) % panes.length;
      const isFront = index === front;
      return <aside
        key={pane.key}
        className={'side-pane' + (isFront ? ' is-front' : '')}
        style={{ '--depth': Math.min(depth,3), zIndex: panes.length + 1 - depth } as CSSProperties}
        role="tabpanel"
        id={stackId+'-panel-'+index}
        aria-labelledby={panes.length>1?stackId+'-tab-'+index:undefined}
        aria-label={panes.length===1?paneTitle(pane):undefined}
        aria-hidden={!isFront}
        inert={!isFront}
        onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void closePane(pane)}}}
        onPointerDown={() => onFront(index)}
      >
        {!entry
          ? <p className="side-pane-missing">This entry is no longer in your library.</p>
          : pane.kind === 'entry'
            ? <EntryPane
                entry={entry}
                dirty={dirtyKeys[pane.key] ?? false}
                onDirty={value => onDirty(pane.key, value)}
                onClose={() => onClose(pane.key)}
                onSave={patch => onSave(entry.id, patch)}
                onDelete={() => onDelete(entry.id)}
                requested={null}
                onNoteOpened={() => {}}
              />
            : <NotePaneEditor
                key={entry.id + ':' + pane.noteId}
                entry={entry}
                noteId={pane.noteId}
                onSave={patch => onSave(entry.id, patch)}
                onDirty={value => onDirty(pane.key, value)}
                registerSave={save => { saveHandlers.current.set(pane.key, save); return () => { saveHandlers.current.delete(pane.key); }; }}
              />}
        <div className="side-pane-top">
          <span>{pane.kind === 'note' ? 'NOTE' : 'ENTRY'}</span>
          <div className="side-pane-tools">
            {depth > 0 && <span className="side-pane-depth">{depth} behind</span>}
            <button type="button" className="pane-close side-pane-close" aria-label={`Close ${pane.kind} pane: ${paneTitle(pane)}`} title={`Close ${paneTitle(pane)}`} onClick={() => { void closePane(pane); }}>×</button>
          </div>
        </div>
      </aside>;
    })}
  </div>;
}
