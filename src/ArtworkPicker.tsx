import { useEffect, useRef, useState } from 'react';

type Artwork = { url: string; title: string; source: string };
export function ArtworkPicker({ title, type, value, onChange, autoSelect = false }: { title: string; type: string; value: string; onChange: (value: string) => void; autoSelect?: boolean }) {
  const [results, setResults] = useState<Artwork[]>([]);
  const autoChoice = useRef('');
  const [state, setState] = useState('');
  useEffect(() => {
    const query = title.trim();
    if (query.length < 2 || type === 'Product') { setResults([]); setState(''); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setState('Finding artwork…');
      try {
        let found: Artwork[] = [];
        if (type === 'TV / Anime') {
          const response = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`, { signal: controller.signal });
          if (!response.ok) throw new Error('Search unavailable');
          const data = await response.json();
          found = data.map((item: {show?: {name?: string; image?: {original?: string; medium?: string}}}) => ({title: item.show?.name ?? query, url: item.show?.image?.original ?? item.show?.image?.medium ?? '', source: 'TVmaze'}));
        } else if (type === 'Manga') {
          const response = await fetch(`https://api.jikan.moe/v4/${type === 'Manga' ? 'manga' : 'anime'}?q=${encodeURIComponent(query)}&limit=8&sfw`, { signal: controller.signal });
          if (!response.ok) throw new Error('Search unavailable');
          const data = await response.json();
          found = (data.data ?? []).map((item: { title?: string; images?: { jpg?: { large_image_url?: string; image_url?: string } } }) => ({ title: item.title ?? query, url: item.images?.jpg?.large_image_url ?? item.images?.jpg?.image_url ?? '', source: 'MyAnimeList via Jikan' }));
        } else if (type === 'Book') {
          const response = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(query)}&fields=title,cover_i&limit=8`, { signal: controller.signal });
          if (!response.ok) throw new Error('Search unavailable');
          const data = await response.json();
          found = (data.docs ?? []).filter((item: {cover_i?: number}) => item.cover_i).map((item: {title: string; cover_i: number}) => ({title: item.title, url: `https://covers.openlibrary.org/b/id/${item.cover_i}-L.jpg`, source: 'Open Library'}));
        } else {
          const media = type === 'Movie' ? 'movie' : type === 'Music' ? 'music' : 'software';
          const response = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=${media}&limit=8`, { signal: controller.signal });
          if (!response.ok) throw new Error('Search unavailable');
          const data = await response.json();
          found = (data.results ?? []).map((item: { trackName?: string; collectionName?: string; artworkUrl100?: string }) => ({ title: item.trackName ?? item.collectionName ?? query, url: (item.artworkUrl100 ?? '').replace('100x100bb', '600x600bb'), source: 'Apple iTunes' }));
        }
        found = found.filter(item => /^https:\/\//i.test(item.url)).slice(0, 8);
        setResults(found); setState(found.length ? '' : 'No suggestions found. You can paste an image link.');
        if (autoSelect && found.length && (!value || value === autoChoice.current)) { autoChoice.current = found[0].url; onChange(found[0].url); }
      } catch (error) { if (!controller.signal.aborted) { setResults([]); setState('Artwork search is unavailable. You can paste an image link.'); } }
    }, 650);
    return () => { controller.abort(); window.clearTimeout(timer); };
  // A selection must not trigger another search or be overwritten.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, type]);
  return <section className="artwork-picker" aria-label="Cover artwork"><div className="artwork-heading"><strong>Cover artwork</strong><span>Choose a suggestion or add a link</span></div>{state && <p role="status">{state}</p>}{results.length > 0 && <div className="artwork-options">{results.map((image, index) => <button type="button" key={image.url + index} className={value === image.url ? 'selected' : ''} aria-label={`Choose artwork for ${image.title}`} aria-pressed={value === image.url} title={image.title} onClick={() => { autoChoice.current = ''; onChange(image.url); }}><img src={image.url} alt="" loading="lazy" referrerPolicy="no-referrer" /></button>)}</div>}{results.length > 0 && <small>Suggestions: {results[0].source}. Select the right title and cover.</small>}<label>Image link <input type="url" value={value} placeholder="https://…" onChange={event => onChange(event.target.value)} /></label>{value && <button type="button" className="artwork-clear" onClick={() => onChange('')}>Remove cover</button>}<small>Artwork is loaded from its source and may be unavailable offline.</small></section>;
}
