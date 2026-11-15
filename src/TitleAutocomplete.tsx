import { useEffect, useId, useRef, useState } from 'react';
import { searchArtwork, type Artwork } from './artwork-search';
export function TitleAutocomplete({ title, type, onTitle, onChoose }: { title: string; type: string; onTitle: (title: string) => void; onChoose: (item: Artwork) => void }) {
  const [items, setItems] = useState<Artwork[]>([]), [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const selected = useRef(''); const listId = useId();
  useEffect(() => {
    const query = title.trim();
    if (query.length < 2 || query === selected.current || type === 'Product') { setItems([]); setOpen(false); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void searchArtwork(query, type, controller.signal).then(results => {
      const seen = new Set<string>();
      const titles = results.filter(item => { const name = item.title.toLocaleLowerCase(); if (seen.has(name)) return false; seen.add(name); return true; });
      setItems(titles.slice(0, 6)); setActive(-1); setOpen(titles.length > 0);
    }).catch(() => { if (!controller.signal.aborted) { setItems([]); setOpen(false); } }); }, 650);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [title, type]);
  const choose = (item: Artwork) => { selected.current = item.title; setOpen(false); setItems([]); setActive(-1); onChoose(item); };
  return <div className="title-autocomplete" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setFocused(false); setOpen(false); } }}>
    <label htmlFor={listId + '-input'}>Title</label><input id={listId + '-input'} role="combobox" autoFocus required maxLength={160} autoComplete="off" value={title} aria-autocomplete="list" aria-expanded={open && focused && items.length > 0} aria-controls={listId} aria-activedescendant={active >= 0 && open && focused ? `${listId}-${active}` : undefined} onFocus={() => { setFocused(true); if (items.length) setOpen(true); }} onChange={event => { selected.current = ''; onTitle(event.target.value); }} onKeyDown={event => {
      if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, items.length - 1)); }
      else if (event.key === 'ArrowUp' && open) { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
      else if (event.key === 'Enter' && open && active >= 0 && items[active]) { event.preventDefault(); event.stopPropagation(); choose(items[active]); }
      else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    }}/>{open && focused && items.length > 0 && <div className="title-suggestions" role="listbox" id={listId} aria-label="Suggested titles">{items.map((item, index) => <button type="button" role="option" id={`${listId}-${index}`} aria-selected={active === index} key={item.title} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>{item.url && <img src={item.url} alt="" referrerPolicy="no-referrer"/>}<span>{item.title}<small>{item.source}</small></span></button>)}</div>}
  </div>;
}
