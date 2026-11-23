import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadWishlist, updateWishlist } from './storage';
import { WishlistControls, WishlistGroups } from './WishlistControls';
import { WishlistBag, WishlistGallery, WishlistItemForm, WishlistTable, type WishlistItemPatch } from './WishlistItems';
import type { WishlistData, WishlistItem } from './wishlist';
import { applyClipboardTitle, clipboardLinkTitle, insertCapturedItem, makeCapturedItem, readWishlistClipboard, undoCapturedItem, type CaptureFields, type CaptureInput } from './wishlist-capture';
import { defaultWishlistArrangement, groupScope, visibleWishlistItems, wishlistSections, type WishlistArrangement } from './wishlist-view';
import './wishlist.css';

type Editor = { kind: 'item'; item?: WishlistItem } | { kind: 'group' | 'view'; id?: string };

function WishlistDialog({ title, onClose, busy, children }: {
  title: string; onClose: () => void; busy: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>('input[name=productLink], input[name=name]')?.focus();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return <dialog ref={ref} className="wishlist-dialog" aria-labelledby="wishlist-dialog-title" onCancel={(event) => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <div className="wishlist-dialog-head">
      <h2 id="wishlist-dialog-title">{title}</h2>
      <button type="button" aria-label="Close dialog" disabled={busy} onClick={onClose}>×</button>
    </div>
    {children}
  </dialog>;
}

export function WishlistPage() {
  const [data, setData] = useState<WishlistData>();
  const [view, setView] = useState(defaultWishlistArrangement);
  const [viewId, setViewId] = useState('');
  const [editor, setEditor] = useState<Editor>();
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [duplicateId, setDuplicateId] = useState<string>();
  const [feedback, setFeedback] = useState('');
  const [undo, setUndo] = useState<{ item: WishlistItem; title?: string }>();
  const [reveal, setReveal] = useState<string>();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const page = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    loadWishlist().then((data) => {
      if (active) setData(data);
    }).catch(() => {
      if (active) setLoadError(true);
    });
    return () => { active = false; };
  }, [reload]);

  const items = useMemo(() => data ? visibleWishlistItems(data.items, view) : [], [data, view]);
  const sections = useMemo(() => data ? wishlistSections(items, data.groups, view) : [], [data, items, view]);
  const scope = groupScope(view.filters);
  const selectedGroup = data?.groups.find((group) => `group:${group.id}` === scope);

  useEffect(() => {
    if (!reveal || editor) return;
    const button = page.current?.querySelector<HTMLElement>(`[data-wishlist-item="${CSS.escape(reveal)}"]`);
    if (!button && data?.items.some((item) => item.id === reveal)) {
      setView((current) => ({ ...current, filters: {} }));
      setViewId('');
      return;
    }
    button?.focus();
    setReveal(undefined);
  }, [data, editor, items, reveal]);

  const handlePaste = useEffectEvent((event: ClipboardEvent) => {
    if (!data || editor || event.defaultPrevented || !event.clipboardData ||
      document.querySelector('dialog[open], [aria-modal="true"]')) return;
    if (event.composedPath().some((node) => node instanceof HTMLElement && (
      node.isContentEditable || node.matches('input, textarea, select, [role="textbox"], [role="combobox"]')
    ))) return;

    try {
      const input = readWishlistClipboard(event.clipboardData);
      if (!input) return;
      event.preventDefault();
      if (!saving.current) void capture(input);
      else setError('Wishlist is saving. Paste again in a moment.');
    } catch {
      event.preventDefault();
      setError('Could not use that product link. Check the URL and paste again.');
    }
  });

  useEffect(() => {
    const listener = (event: ClipboardEvent) => handlePaste(event);
    document.addEventListener('paste', listener);
    return () => document.removeEventListener('paste', listener);
  }, []);

  function openEditor(next: Editor) {
    if (saving.current) return;
    setError('');
    setDuplicateId(undefined);
    setFeedback('');
    setEditor(next);
  }

  function closeEditor() {
    setError('');
    setDuplicateId(undefined);
    setEditor(undefined);
  }

  async function writeWishlist(write: () => Promise<WishlistData>) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const next = await write();
      setData(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error && /^Invalid Wishlist |^Wishlist storage is full/.test(cause.message)
        ? cause.message : 'Could not save to Wishlist on this device. Try again.');
      return;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function persist(edit: (draft: WishlistData) => void) {
    return writeWishlist(() => updateWishlist((draft) => {
      edit(draft);
      return draft;
    }));
  }

  async function capture(input: CaptureInput, fields?: CaptureFields) {
    if (fields) setDuplicateId(undefined);
    let outcome: ReturnType<typeof insertCapturedItem> | undefined;
    const next = await writeWishlist(async () => {
      const item = await makeCapturedItem(input, fields?.groupIds ?? (selectedGroup ? [selectedGroup.id] : []), fields);
      return updateWishlist((draft) => {
        outcome = insertCapturedItem(draft, item, { joinDuplicateGroups: !fields });
        return draft;
      });
    });
    if (!next || !outcome) return;
    const { id, created, joined } = outcome;
    const saved = next.items.find((item) => item.id === id);
    if (!saved) return;
    if (fields && !created) {
      setDuplicateId(id);
      return;
    }
    if (fields) closeEditor();
    setReveal(id);
    if (!created) {
      setFeedback(joined ? `Already saved. Added “${saved.name}” to the selected groups.` : `“${saved.name}” is already in Wishlist.`);
      return;
    }

    // Save first. Rich clipboard titles can then fill an untouched placeholder.
    const title = fields?.name ? undefined : clipboardLinkTitle(input);
    setUndo({ item: saved, title });
    setFeedback(input.kind === 'url' ? 'Product link saved.' : `Added “${saved.name}”.`);
    if (title) {
      try {
        setData(await updateWishlist((draft) => {
          applyClipboardTitle(draft, saved, title);
          return draft;
        }));
      } catch {
        // The link was already saved. A title update is optional.
      }
    }
  }

  async function undoCapture() {
    if (!undo) return;
    let removed = false;
    const next = await persist((draft) => {
      removed = undoCapturedItem(draft, undo.item, undo.title);
    });
    if (!next) return;
    setUndo(undefined);
    setFeedback(removed ? 'Removed the captured item.' : 'This item changed after capture. It was kept.');
    page.current?.querySelector<HTMLButtonElement>('.wishlist-heading button')?.focus();
  }

  async function updateItem(id: string, patch: WishlistItemPatch) {
    return persist((draft) => {
      const item = draft.items.find((item) => item.id === id);
      if (!item) throw new Error('Invalid Wishlist item. It may have been removed in another tab.');
      Object.assign(item, patch);
    });
  }

  function selectView(id: string) {
    const saved = data?.views.find((view) => view.id === id);
    if (saved) {
      const { layout, filters, sort, groupBy } = saved;
      setView({ layout, filters, sort, groupBy });
    } else {
      setView(defaultWishlistArrangement);
    }
    setViewId(saved?.id ?? '');
    setFeedback('');
  }

  if (!data) return <section className="wishlist-page" aria-labelledby="wishlist-heading">
    <h1 id="wishlist-heading">Wishlist</h1>
    {loadError ? <div className="wishlist-empty">
      <p role="alert">Could not open your Wishlist on this device.</p>
      <button type="button" onClick={() => { setLoadError(false); setReload((value) => value + 1); }}>Try again</button>
    </div> : <p role="status">Loading Wishlist…</p>}
  </section>;

  const manageGroup = editor?.kind === 'group' ? data.groups.find((group) => group.id === editor.id) : undefined;
  const manageView = editor?.kind === 'view' ? data.views.find((view) => view.id === editor.id) : undefined;

  async function saveName(name: string) {
    if (!editor || editor.kind === 'item') return;
    if (!name.trim()) {
      setError('Enter a name.');
      return;
    }
    const kind = editor.kind;
    const id = editor.id ?? crypto.randomUUID();
    const saved = await persist((draft) => {
      const records = kind === 'group' ? draft.groups : draft.views;
      if (records.some((record) => record.id !== id && record.name.toLowerCase() === name.toLowerCase()) ||
          (kind === 'group' && ['all items', 'ungrouped'].includes(name.toLowerCase()))) {
        throw new Error(`Invalid Wishlist name. Choose a different ${kind} name.`);
      }
      const existing = records.find((record) => record.id === id);
      if (editor.id && !existing) throw new Error(`Invalid Wishlist ${kind}. It may have been removed in another tab.`);
      if (kind === 'group') {
        if (existing) existing.name = name;
        else draft.groups.push({ id, name });
      } else {
        const next = { ...view, id, name };
        if (existing) draft.views = draft.views.map((saved) => saved.id === id ? next : saved);
        else draft.views.push(next);
      }
    });
    if (!saved) return;
    if (kind === 'view') setViewId(id);
    if (kind === 'group' && !editor.id) {
      setView((current) => ({ ...current, filters: { ...current.filters, groupIds: [id], ungrouped: false } }));
    }
    setFeedback(kind === 'view' ? `Saved view “${name}”.` : `Saved group “${name}”.`);
    closeEditor();
  }

  async function removeGroup(id: string, name: string) {
    if (!confirm(`Remove “${name}” from Wishlist? Its items will remain. The group will also be removed from saved filters.`)) return;
    if (!await persist((draft) => {
      draft.groups = draft.groups.filter((group) => group.id !== id);
      for (const item of draft.items) item.groupIds = item.groupIds.filter((key) => key !== id);
      for (const saved of draft.views) {
        if (saved.filters.groupIds) saved.filters.groupIds = saved.filters.groupIds.filter((key) => key !== id);
      }
    })) return;
    setView((current) => ({
      ...current, filters: { ...current.filters, groupIds: current.filters.groupIds?.filter((key) => key !== id) },
    }));
    closeEditor();
  }

  async function removeView(id: string, name: string) {
    if (!confirm(`Remove the saved view “${name}”?`)) return;
    if (!await persist((draft) => { draft.views = draft.views.filter((view) => view.id !== id); })) return;
    selectView('');
    closeEditor();
  }

  return <section ref={page} className="wishlist-page" aria-labelledby="wishlist-heading">
    <header className="wishlist-heading">
      <div><h1 id="wishlist-heading">Wishlist</h1><span className="wishlist-count" aria-live="polite">
        {items.length} {items.length === 1 ? 'item' : 'items'}
      </span></div>
      <button className="wishlist-primary" type="button" disabled={busy} onClick={() => openEditor({ kind: 'item' })}>+ Add item</button>
    </header>
    <WishlistGroups groups={data.groups} filters={view.filters}
      onChange={(filters) => { setView({ ...view, filters }); setFeedback(''); }}
      onAdd={() => openEditor({ kind: 'group' })}
      onManage={(id) => openEditor({ kind: 'group', id })} disabled={busy}/>
    <WishlistControls data={data} view={view} onChange={(view) => { setView(view); setFeedback(''); }}
      viewId={viewId} onSelectView={selectView} onSave={() => openEditor({ kind: 'view' })}
      onManage={() => openEditor({ kind: 'view', id: viewId })} busy={busy}/>
    {error && !editor && <p role="alert" className="wishlist-error">{error}</p>}
    {(feedback || undo) && <div className="wishlist-capture-feedback">
      <p role="status" className="wishlist-feedback">{feedback || 'Item captured.'}</p>
      {undo && <button type="button" disabled={busy} onClick={() => void undoCapture()}>Undo</button>}
    </div>}
    {items.length ? <div className="wishlist-results">
      {sections.map((section) => <section key={section.id}>
        {section.name && <h2>{section.name} <span>{section.items.length}</span></h2>}
        {view.layout === 'gallery' ? <WishlistGallery items={section.items} groups={data.groups}
          onEdit={(item) => openEditor({ kind: 'item', item })}/>
          : <WishlistTable items={section.items} groups={data.groups} label={section.name ?? 'Wishlist'} busy={busy}
            onEdit={(item) => openEditor({ kind: 'item', item })} onUpdate={updateItem}/>}
      </section>)}
    </div> : <div className="wishlist-empty">
      <WishlistBag size={32}/>
      <h2>{data.items.length ? 'No matching items' : 'Your Wishlist is empty'}</h2>
      {data.items.length ? <button type="button" onClick={() => setView({ ...view, filters: {} })}>Clear filters</button>
        : <p>Paste a product link, image, or text to add your first item.</p>}
    </div>}
    {editor?.kind === 'item' && <WishlistDialog key={editor.item ? `item:${editor.item.id}` : 'new-item'} title={editor.item ? 'Edit item' : 'Add item'} onClose={closeEditor} busy={busy}>
      {error && <p role="alert" className="wishlist-error">{error}</p>}
      {duplicateId && <div className="wishlist-capture-feedback">
        <p role="alert" className="wishlist-feedback">This link is already saved. Change the link to keep this draft, or discard the draft and edit the saved item.</p>
        <button type="button" disabled={busy} onClick={() => {
          const match = data.items.find((item) => item.id === duplicateId);
          if (match) openEditor({ kind: 'item', item: match });
        }}>Discard draft and edit saved item</button>
      </div>}
      <WishlistItemForm item={editor.item} groups={data.groups} initialGroups={selectedGroup ? [selectedGroup.id] : []}
        busy={busy} onCancel={closeEditor} onSubmit={async (values, productLink) => {
          const original = editor.item;
          if (!original && productLink) {
            await capture({ kind: 'url', url: productLink }, values);
            return;
          }
          let saved: WishlistData | undefined;
          if (original) {
            const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) =>
              JSON.stringify(value) !== JSON.stringify(original[key as keyof WishlistItem]),
            ));
            saved = await updateItem(original.id, patch);
          } else {
            const item: WishlistItem = { ...values, id: crypto.randomUUID(), createdAt: new Date().toISOString(), offers: [], purchases: [] };
            saved = await persist((draft) => { draft.items.push(item); });
          }
          if (saved) {
            setFeedback(original ? `Saved “${values.name}”.` : `Added “${values.name}”.`);
            closeEditor();
          }
        }}/>
    </WishlistDialog>}
    {editor && editor.kind !== 'item' && <WishlistDialog
      title={editor.kind === 'group' ? manageGroup ? 'Edit group' : 'New group' : manageView ? 'Edit saved view' : 'Save view'}
      onClose={closeEditor} busy={busy}>
      <form className="wishlist-form" onSubmit={(event) => {
        event.preventDefault();
        void saveName(String(new FormData(event.currentTarget).get('name') ?? '').trim());
      }}>
        <label>Name<input name="name" maxLength={120} required defaultValue={manageGroup?.name ?? manageView?.name}/></label>
        {manageView && <p>Saving replaces this view with the current layout, filters, sort and grouping.</p>}
        {error && <p role="alert" className="wishlist-error">{error}</p>}
        <div className="wishlist-dialog-actions">
          {manageGroup && <button className="wishlist-remove" type="button" disabled={busy}
            onClick={() => void removeGroup(manageGroup.id, manageGroup.name)}>Remove group</button>}
          {manageView && <button className="wishlist-remove" type="button" disabled={busy}
            onClick={() => void removeView(manageView.id, manageView.name)}>Remove view</button>}
          <button type="button" disabled={busy} onClick={closeEditor}>Cancel</button>
          <button type="submit" className="wishlist-primary" disabled={busy}>Save {editor.kind}</button>
        </div>
      </form>
    </WishlistDialog>}
  </section>;
}
