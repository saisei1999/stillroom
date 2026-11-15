import { useEffect, useRef, useState } from 'react';

import { searchArtwork, type Artwork } from './artwork-search';
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
        const found = await searchArtwork(query, type, controller.signal);
        setResults(found); setState(found.length ? '' : 'No suggestions found. You can paste an image link.');
        if (autoSelect && found.length && (!value || value === autoChoice.current)) { autoChoice.current = found[0].url; onChange(found[0].url); }
      } catch (error) { if (!controller.signal.aborted) { setResults([]); setState('Artwork search is unavailable. You can paste an image link.'); } }
    }, 650);
    return () => { controller.abort(); window.clearTimeout(timer); };
  // A selection must not trigger another search or be overwritten.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, type]);
  return <section className="artwork-picker" aria-label="Cover artwork"><div className="artwork-heading"><strong>Cover artwork</strong><span>Choose a suggestion or add a link</span></div>{state && <p role="status">{state}</p>}{results.length > 0 && <div className="artwork-options">{results.map((image, index) => <button type="button" key={image.url + index} className={value === image.url ? 'selected' : ''} aria-label={`Choose artwork for ${image.title}`} aria-pressed={value === image.url} title={image.title} onClick={() => { autoChoice.current = ''; onChange(image.url); }}><img src={image.url} alt="" loading="lazy" referrerPolicy="no-referrer" /></button>)}</div>}{results.length > 0 && <small>Sources: {[...new Set(results.map(result => result.source))].join(', ')}. Select the right title and cover.</small>}<label>Image link <input type="url" value={value} placeholder="https://…" onChange={event => onChange(event.target.value)} /></label>{value && <button type="button" className="artwork-clear" onClick={() => onChange('')}>Remove cover</button>}<small>Artwork is loaded from its source and may be unavailable offline.</small></section>;
}
