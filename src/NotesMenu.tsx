import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BlockEditor } from './BlockEditor';

export type NoteSection = { id: string; title: string; body: string };

type Props = {
  general: string;
  sections: NoteSection[];
  onGeneral: (value: string) => void;
  onSections: (value: NoteSection[]) => void;
  dirty: boolean;
  saving: boolean;
  requested: { id: string; sequence: number } | null;
  onOpened: (id: string) => void;
  onRequestSave: () => void;
  saveError?: boolean;
  onOpenInPane?: (id: string) => void;
};

export function NotesMenu({ general, sections, onGeneral, onSections, dirty, saving, requested, onOpened, onRequestSave, onOpenInPane, saveError = false }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const paneId = useId();
  const pane = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const contextTrigger = useRef<HTMLElement | null>(null);
  const entryScroll = useRef({ x: 0, y: 0 });
  const lastRequest = useRef<Props['requested']>(null);
  const current = sections.find(section => section.id === active);
  const open = !!active && (active === 'general' || !!current);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!requested || lastRequest.current === requested) return;
    if (requested.id !== 'general' && !sections.some(section => section.id === requested.id)) return;
    lastRequest.current = requested;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    entryScroll.current = { x: window.scrollX, y: window.scrollY };
    setActive(requested.id);
  }, [requested, sections]);

  useEffect(() => {
    if (!open) return;
    // Prevent editor focus from scrolling the entry out from underneath its pane.
    const target = pane.current?.querySelector<HTMLElement>('input, .pane-close');
    target?.focus({ preventScroll: true });
  }, [open, active]);

  useEffect(() => {
    if (!open || !mobile) return;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    const siblings = Array.from(pane.current?.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== pane.current);
    const previousInert = siblings.map(element => element.inert);
    siblings.forEach(element => { element.inert = true; });
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previousOverflow;
      siblings.forEach((element, index) => { element.inert = previousInert[index]; });
    };
  }, [open, mobile]);

  useEffect(() => {
    if (!context) return;
    contextRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (!contextRef.current?.contains(event.target as Node)) setContext(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [context]);

  const showContext = (id: string, source: HTMLElement, x: number, y: number) => {
    if (!onOpenInPane) return;
    contextTrigger.current = source;
    setContext({ id, x: Math.max(8, Math.min(x, window.innerWidth - 232)), y: Math.max(8, Math.min(y, window.innerHeight - 112)) });
  };
  const activate = (id: string, trigger: HTMLElement) => {
    entryScroll.current = { x: window.scrollX, y: window.scrollY };
    opener.current = trigger;
    setActive(id);
    onOpened(id);
  };
  const close = () => {
    setActive(null);
    // Mobile siblings become interactive again after the dialog effect cleans up.
    requestAnimationFrame(() => {
      window.scrollTo(entryScroll.current.x, entryScroll.current.y);
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    });
  };
  const update = (patch: Partial<NoteSection>) => onSections(sections.map(section => section.id === active ? { ...section, ...patch } : section));
  const notes = [
    { id: 'general', title: 'General notes', body: general, hint: 'Your overall thoughts and review' },
    ...sections.map(section => ({ id: section.id, title: section.title || 'Untitled note', body: section.body, hint: 'Add your thoughts…' })),
  ];
  const notePane = open ? <aside ref={pane} id={paneId} className="note-pane" role="dialog" aria-modal={mobile || undefined} aria-label="Note editor" onKeyDown={event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (mobile && event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, [contenteditable=true], [tabindex="0"]'))
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <div className="note-pane-top"><span>NOTE</span><button type="button" className="pane-close" aria-label="Close note" onClick={close}>×</button></div>
    <div className="note-pane-content">{active === 'general' ? <><h2>General notes</h2><BlockEditor key="general" value={general} onChange={onGeneral} /></> : current ? <>
      <label className="note-pane-title"><span className="sr-only">Note title</span><input value={current.title} maxLength={120} onChange={event => update({ title: event.target.value })} placeholder="Note title" /></label>
      <BlockEditor key={current.id} value={current.body} onChange={value => update({ body: value })} />
    </> : null}</div>
    <div className="note-pane-footer">{current && <button type="button" className="note-remove" onClick={() => {
      if (!confirm('Remove this note? This change is saved automatically.')) return;
      onSections(sections.filter(section => section.id !== active));
      close();
    }}>Remove note</button>}<span aria-live="polite">{saveError ? 'Could not save. Changes are still here.' : saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>{saveError && <button type="button" className="pane-save" disabled={saving} onClick={onRequestSave}>Try again</button>}</div>
  </aside> : null;
  const host = typeof document !== 'undefined' ? document.querySelector('.shell') : null;
  return <section className="notes-menu" aria-label="Entry notes">
    <div className="notes-heading"><h2>Notes</h2><button type="button" aria-haspopup="dialog" onClick={event => {
      const id = crypto.randomUUID();
      onSections([...sections, { id, title: `Note ${sections.length + 1}`, body: '' }]);
      activate(id, event.currentTarget);
    }}>+ New note</button></div>
    <div className="notes-gallery" aria-label="Notes gallery">{notes.map(note =>
      <button type="button" key={note.id} className="note-card" aria-haspopup="dialog" onContextMenu={event => {
        if (!onOpenInPane) return;
        event.preventDefault();
        showContext(note.id, event.currentTarget, event.clientX, event.clientY);
      }} onKeyDown={event => {
        if (onOpenInPane && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          showContext(note.id, event.currentTarget, rect.right, rect.top);
        }
      }} aria-controls={open && active === note.id ? paneId : undefined} onClick={event => activate(note.id, event.currentTarget)}>
        <strong>{note.title}</strong>
        <span>{note.body.replace(/[#*_`>\[\]]/g, '').trim() || note.hint}</span>
        <small>Open <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 12h14m-6-6 6 6-6 6" /></svg></small>
      </button>)}</div>
    {context && createPortal(<div ref={contextRef} className="view-context-menu" role="menu" aria-label="Note actions" style={{ left: context.x, top: context.y }} onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setContext(null);
        contextTrigger.current?.focus({ preventScroll: true });
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    }}>
      <button type="button" role="menuitem" onClick={() => { const id = context.id; setContext(null); activate(id, contextTrigger.current!); }}>Open note</button>
      <button type="button" role="menuitem" onClick={() => { const id = context.id; setContext(null); onOpened(id); onOpenInPane?.(id); }}>Open in right pane</button>
    </div>, document.body)}
    {host && notePane && createPortal(notePane, host)}
  </section>;
}
