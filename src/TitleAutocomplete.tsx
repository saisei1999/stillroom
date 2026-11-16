import { useEffect, useId, useRef, useState } from 'react';
import { searchArtwork, type Artwork } from './artwork-search';
import { mediaType, region, request } from './AvailabilityPanel';
export function TitleAutocomplete({ title, type, onTitle, onChoose }: { title: string; type: string; onTitle: (title: string) => void; onChoose: (item: Artwork) => void }) {
  const [items, setItems] = useState<Artwork[]>([]), [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const selected = useRef(''); const listId = useId();
  useEffect(() => {
    const query = title.trim();
    if (query.length < 2 || query === selected.current || type === 'Product') { setItems([]); setOpen(false); return; }
    const controller = new AbortController();
    let live = true;
    const timer = window.setTimeout(() => { void (async () => {
      const kind = mediaType(type);
      if (kind) {
        const result = await request(query, kind, region());
        if (!live) return;
        const candidates = Array.isArray(result.matches) ? result.matches.filter(item => item && /^\d{1,12}$/.test(item.id) && typeof item.title === 'string' && item.title.trim() && (item.year === undefined || (Number.isInteger(item.year) && item.year >= 1800 && item.year <= 2200))) : [];
        const items: Artwork[] = candidates.map(item => ({ title:item.title, url:typeof item.artworkUrl === 'string' && /^https:\/\/image\.tmdb\.org\/t\/p\/w500\/[A-Za-z0-9_.-]+$/.test(item.artworkUrl) ? item.artworkUrl : '', source:kind === 'game' ? 'IGDB' : 'TMDB', providerMatch:{id:item.id,title:item.title,...(item.year === undefined ? {} : {year:item.year}),mediaType:kind,query:item.title} }));
        setItems(items.slice(0, 8)); setActive(-1); setOpen(items.length > 0);
      } else {
        const results = await searchArtwork(query, type, controller.signal);
        if (!live) return;
        const seen = new Set<string>();
        const titles = results.filter(item => { const name = item.title.toLocaleLowerCase(); if (seen.has(name)) return false; seen.add(name); return true; });
        setItems(titles.slice(0, 6)); setActive(-1); setOpen(titles.length > 0);
      }
    })().catch(() => { if (live) { setItems([]); setOpen(false); } }); }, 650);
    return () => { live = false; controller.abort(); window.clearTimeout(timer); };
  }, [title, type]);
  const choose = (item: Artwork) => { selected.current = item.title; setOpen(false); setItems([]); setActive(-1); onChoose(item); };
  return <div className="title-autocomplete" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setFocused(false); setOpen(false); } }}>
    <label htmlFor={listId + '-input'}>Title</label><input id={listId + '-input'} role="combobox" autoFocus required maxLength={160} autoComplete="off" value={title} aria-autocomplete="list" aria-expanded={open && focused && items.length > 0} aria-controls={listId} aria-activedescendant={active >= 0 && open && focused ? `${listId}-${active}` : undefined} onFocus={() => { setFocused(true); if (items.length) setOpen(true); }} onChange={event => { selected.current = ''; onTitle(event.target.value); }} onKeyDown={event => {
      if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, items.length - 1)); }
      else if (event.key === 'ArrowUp' && open) { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
      else if (event.key === 'Enter' && open && active >= 0 && items[active]) { event.preventDefault(); event.stopPropagation(); choose(items[active]); }
      else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    }}/>{open && focused && items.length > 0 && <div className="title-suggestions" role="listbox" id={listId} aria-label="Suggested titles">{items.map((item, index) => <button type="button" role="option" id={`${listId}-${index}`} aria-selected={active === index} key={item.providerMatch ? `${item.providerMatch.mediaType}:${item.providerMatch.id}` : item.title} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>{item.url && <img src={item.url} alt="" referrerPolicy="no-referrer"/>}<span>{item.title}{item.providerMatch?.year ? ` (${item.providerMatch.year})` : ''}<small>{item.source}</small></span></button>)}</div>}
  </div>;
}
