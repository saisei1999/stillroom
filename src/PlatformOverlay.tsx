import { useEffect, useRef, useState } from 'react';
import { confirmedMatch, gameStoreUrl, normalizeTitle, providerKey } from './availability';
import { mediaType, region, request, requestWatchmode, useLookupAccount } from './AvailabilityPanel';
import { VERIFIED_LINKS_ENABLED } from './watchmode';
import type { Entry } from './storage';
import { PlatformIcon } from './PlatformIcon';

export function PlatformOverlay({ entry }: {entry:Entry; onOpen:()=>void}) {
  const lookupAccount = useLookupAccount();
  const anchor = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false);
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') { setNearby(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setNearby(true); observer.disconnect(); } }, { rootMargin:'200px' });
    observer.observe(element.closest('.cover') ?? element);
    return () => observer.disconnect();
  }, []);
  const [country, setCountry] = useState(region);
  const identity = JSON.stringify([entry.id, entry.title, entry.type, entry.availabilityMatch?.id, entry.availabilityMatch?.query, entry.availabilityMatch?.title, entry.availabilityMatch?.year, entry.availabilityMatch?.mediaType, country, lookupAccount]);
  const [linkState, setLinkState] = useState<{key:string; links:{name:string;titleUrl:string}[]}>({key:'',links:[]});
  const links = linkState.key === identity ? linkState.links : [];
  useEffect(() => {
    const update = () => setCountry(region());
    window.addEventListener('stillroom-region-change', update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener('stillroom-region-change', update); window.removeEventListener('storage', update); };
  }, []);
  useEffect(() => {
    let active = true;
    setLinkState({key:identity,links:[]});
    if (!VERIFIED_LINKS_ENABLED || !lookupAccount || !nearby) return () => { active = false; };
    const kind = mediaType(entry.type);
    const match = kind && confirmedMatch(entry.availabilityMatch, entry.title, kind);
    if (!match || !kind) return () => { active = false; };
    if (kind === 'game') {
      void request(entry.title, kind, country, match.id).then(data => {
        if (!active || typeof data.matchedTitle !== 'string' || normalizeTitle(data.matchedTitle) !== normalizeTitle(match.title)) return;
        const links = (data.links ?? []).flatMap(link => { const url = gameStoreUrl(link.name, link.url); return url ? [{name:link.name,titleUrl:url}] : []; });
        setLinkState({key:identity,links:links.filter((item,index,all) => all.findIndex(other => providerKey(other.name) === providerKey(item.name)) === index)});
      }).catch(() => {});
      return () => { active = false; };
    }
    if (kind !== 'movie' && kind !== 'tv') return () => { active = false; };
    void requestWatchmode(entry.title,kind,country,match.id).then(data => {
      if (active) setLinkState({key:identity,links:data.candidates.filter(item => item.verified === true).filter((item,index,all) => all.findIndex(other => providerKey(other.name) === providerKey(item.name)) === index)});
    }).catch(() => { /* An unresolved link never becomes an icon. */ });
    return () => { active = false; };
  }, [identity, entry.title, entry.type, entry.availabilityMatch, country, lookupAccount, nearby]);
  return <div ref={anchor} className="platform-overlay" aria-label="Platforms" onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}>
    {links.slice(0,6).map(link=><a key={providerKey(link.name)} href={link.titleUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${entry.title} on ${link.name}`} title={`Open ${link.name}`}><PlatformIcon name={link.name}/></a>)}
    {links.length>0 && <a className="platform-credit" href={entry.type==='Game'?'https://www.igdb.com/':'https://www.watchmode.com/'} target="_blank" rel="noopener noreferrer" aria-label={entry.type==='Game'?'Game links by IGDB':'Streaming links by Watchmode'}>{entry.type==='Game'?'IGDB':'Watchmode'}</a>}
  </div>;
}
