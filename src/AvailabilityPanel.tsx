import { useEffect, useRef, useState } from 'react';
import { VERIFIED_LINKS_ENABLED, watchmodeCandidates, type WatchmodeCandidate } from './watchmode';
import { chooseMatch, confirmedMatch, gameStoreUrl, normalizeTitle, providerKey, providerTarget, safeAvailabilityUrl, type AvailabilityMatch, type ChosenMatch, type PersonalLink } from './availability';
import { PlatformIcon } from './PlatformIcon';
import { accountClient } from './AccountPanel';

const productionEndpoint = 'https://hmrmcpsrzrhwquyxdfta.supabase.co/functions/v1/media-availability';
// Only development builds can use the local fixture service.
const fixtureEndpoint = import.meta.env.DEV ? import.meta.env.VITE_AVAILABILITY_FIXTURE : undefined;
const endpoint = typeof fixtureEndpoint === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/availability$/.test(fixtureEndpoint) ? fixtureEndpoint : productionEndpoint;
const usingFixture = endpoint !== productionEndpoint;
const key = 'sb_publishable_FHbJZbLEkfdSI4ZDURFUjg_SjTTEbyB';
const regionKey = 'stillroom-availability-region';
export type Link = { name: string; url: string; kind: string; logo?: string };
type Data = { matches?: AvailabilityMatch[]; links?: Link[]; source?: string; availabilityPage?: string; matchedTitle?: string };
type WatchmodeData = { source: 'Watchmode'; mediaType: string; externalId: string; region: string; candidates: WatchmodeCandidate[]; retryable?: boolean };
const inFlight = new Map<string,Promise<Data>>();
export function region(): string { try { const value = localStorage.getItem(regionKey); return value && /^[A-Z]{2}$/.test(value) ? value : 'US'; } catch { return 'US'; } }
export function mediaType(type: string) { return type === 'Movie' ? 'movie' : type === 'TV / Anime' ? 'tv' : type === 'Game' ? 'game' : undefined; }
export async function request(title: string, type: string, country: string, id?: string): Promise<Data> {
  const restricted = type === 'game' && !!id;
  const session = restricted && !usingFixture ? (await accountClient.auth.getSession()).data.session : null;
  if (restricted && !usingFixture && (!session?.access_token || !session.user?.id || session.user.is_anonymous === true)) throw new Error('Sign in required');
  const cacheKey = `stillroom-availability:${restricted ? (session?.user.id ?? 'fixture') : 'public'}:${type}:${country}:${title}:${id ?? 'search'}`;
  try { const cached = JSON.parse(sessionStorage.getItem(cacheKey) ?? 'null'); if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.value as Data; } catch { /* cache is optional */ }
  const pending = inFlight.get(cacheKey); if (pending) return pending;
  const operation = fetchAvailability(title,type,country,id,cacheKey,session?.access_token); inFlight.set(cacheKey,operation);
  try { return await operation; } finally { inFlight.delete(cacheKey); }
}
async function fetchAvailability(title:string,type:string,country:string,id:string|undefined,cacheKey:string,token?:string):Promise<Data> {
  const url = new URL(endpoint); url.search = new URLSearchParams({ title, type, region: country, ...(id ? { id } : {}) }).toString();
  const result = await fetch(url, { headers: { apikey: key, ...(token ? {Authorization:`Bearer ${token}`} : {}) }, signal: AbortSignal.timeout(12000) });
  if (!result.ok) throw new Error('Lookup failed');
  const value = await result.json() as Data;
  try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), value })); } catch { /* cache is optional */ }
  return value;
}
const watchmodeCache = new Map<string, { at: number; value: WatchmodeData }>();
const watchmodePending = new Map<string, Promise<WatchmodeData>>();
const WATCHMODE_CACHE_MS = 6 * 60 * 60 * 1000;
export async function requestWatchmode(title: string, type: string, country: string, id: string): Promise<WatchmodeData> {
  const session = usingFixture ? null : (await accountClient.auth.getSession()).data.session;
  if (!usingFixture && (!session?.access_token || !session.user?.id || session.user.is_anonymous === true)) throw new Error('Sign in required');
  const account = usingFixture ? 'fixture' : session!.user.id;
  const cacheKey = JSON.stringify([account, type, id, country]);
  const cached = watchmodeCache.get(cacheKey);
  if (cached && Date.now() >= cached.at && Date.now() - cached.at < WATCHMODE_CACHE_MS) return cached.value;
  watchmodeCache.delete(cacheKey);
  const pending = watchmodePending.get(cacheKey);
  if (pending) return pending;
  const operation = fetchWatchmode(title, type, country, id, session?.access_token).then(value => {
    if (!value.retryable) { if (watchmodeCache.size >= 100) watchmodeCache.delete(watchmodeCache.keys().next().value!); watchmodeCache.set(cacheKey, { at: Date.now(), value }); }
    return value;
  });
  watchmodePending.set(cacheKey, operation);
  try { return await operation; } finally { watchmodePending.delete(cacheKey); }
}
async function fetchWatchmode(title: string, type: string, country: string, id: string, token?: string): Promise<WatchmodeData> {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ title, type, region: country, id, source: 'watchmode' }).toString();
  const response = await fetch(url, { headers: { apikey: key, ...(token ? {Authorization:`Bearer ${token}`} : {}) }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Lookup failed');
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object') throw new Error('Invalid response');
  const data = result as Record<string, unknown>;
  if (data.source !== 'Watchmode' || data.mediaType !== type || data.externalId !== id || data.region !== country || !Array.isArray(data.candidates)) throw new Error('Invalid response');
  // Revalidate data crossing the network boundary. The adapter expects upstream field names.
  const candidates = watchmodeCandidates(data.candidates.map((value: any) => ({ source_id: value?.sourceId, name: value?.name, region: value?.region, type: value?.offerType, web_url: value?.titleUrl })), country);
  return { source: 'Watchmode', mediaType: type, externalId: id, region: country, candidates, ...(data.retryable === true ? {retryable:true} : {}) };
}
export function useLookupAccount(): string | null {
  const [account, setAccount] = useState<string | null>(usingFixture ? 'fixture' : null);
  useEffect(() => {
    if (usingFixture) return;
    let live = true, authEvent = false;
    const { data: { subscription } } = accountClient.auth.onAuthStateChange((_event, session) => { authEvent = true; if (live) setAccount(session?.user.is_anonymous ? null : session?.user.id ?? null); });
    void accountClient.auth.getSession().then(({data}) => { if (live && !authEvent) setAccount(data.session?.user.is_anonymous ? null : data.session?.user.id ?? null); }).catch(() => { if (live && !authEvent) setAccount(null); });
    return () => { live = false; subscription.unsubscribe(); };
  }, []);
  return account;
}
function kindForWatchmode(type: string, preferred: ChosenMatch | undefined, title: string): ChosenMatch | undefined {
  const kind = mediaType(type);
  return (kind === 'movie' || kind === 'tv') && confirmedMatch(preferred, title, kind) ? preferred : undefined;
}
export function AvailabilityPanel({ title, type, links, onLinks, preferred, onPreferred }: {title:string; type:string; links:PersonalLink[]; onLinks:(links:PersonalLink[])=>void; preferred?:ChosenMatch; onPreferred:(match:ChosenMatch)=>void}) {
  const lookupAccount = useLookupAccount();
  const [country, setCountry] = useState(region), [matches, setMatches] = useState<AvailabilityMatch[]>([]), [selected, setSelected] = useState<AvailabilityMatch | null>(null);
  const [data, setData] = useState<Data | null>(null), [state, setState] = useState<'loading'|'ready'|'error'>('loading');
  const [editing, setEditing] = useState<string | null>(null), [label, setLabel] = useState(''), [url, setUrl] = useState(''), [message, setMessage] = useState('');
  const [watchmode, setWatchmode] = useState<WatchmodeData | null>(null);
  const [watchmodeOwner, setWatchmodeOwner] = useState<string | null>(null);
  const [watchmodeState, setWatchmodeState] = useState<'idle'|'loading'|'error'>('idle');
  const watchmodeGeneration = useRef(0);
  useEffect(() => { watchmodeGeneration.current++; setWatchmode(null); setWatchmodeOwner(null); setWatchmodeState('idle'); }, [title, type, country, selected?.id, lookupAccount]);
  useEffect(() => {
    if (!VERIFIED_LINKS_ENABLED || !lookupAccount) return;
    const confirmed = kindForWatchmode(type, preferred, title);
    if (!confirmed || selected?.id !== confirmed.id || !/^[A-Z]{2}$/.test(country)) return;
    let current = true;
    setWatchmodeState('loading');
    void requestWatchmode(title, confirmed.mediaType, country, confirmed.id).then(result => {
      if (current) { setWatchmode(result); setWatchmodeOwner(lookupAccount); setWatchmodeState('idle'); }
    }).catch(() => { if (current) setWatchmodeState('error'); });
    return () => { current = false; };
  }, [title, type, country, preferred, lookupAccount, selected?.id]);
  const [retry, setRetry] = useState(0), [detailsOpen,setDetailsOpen] = useState(false), kind = mediaType(type);
  useEffect(() => {
    let active = true; setMatches([]); setSelected(null); setData(null);
    if (!kind || !title.trim()) { setState('ready'); return () => { active = false; }; }
    const confirmed = confirmedMatch(preferred, title, kind);
    if (confirmed) { setSelected(confirmed); return () => { active = false; }; }
    setState('loading');
    request(title, kind, country).then(result => {
      if (!active) return;
      const candidates = Array.isArray(result.matches) ? result.matches.filter(item => item && /^\d+$/.test(item.id) && typeof item.title === 'string') : [];
      const decision = chooseMatch(title, candidates);
      const saved = preferred?.mediaType === kind && preferred.query === title ? candidates.find(item => item.id === preferred.id) : undefined;
      if (saved) { setMatches(candidates); setSelected(saved); }
      else if (decision.kind === 'automatic') { setMatches([decision.match]); setState('ready'); }
      else { setMatches(decision.kind === 'choose' ? decision.matches : []); setState('ready'); }
    }).catch(() => { if (active) setState('error'); });
    return () => { active = false; };
  }, [title, kind, country, retry, preferred]);
  useEffect(() => {
    if (!kind || !selected) return;
    if (kind === 'game' && !lookupAccount) { setState('ready'); return; }
    let active = true; setState('loading'); setData(null);
    request(title, kind, country, selected.id).then(result => { if (active) { setData(result); setState('ready'); } }).catch(() => { if (active) setState('error'); });
    return () => { active = false; };
  }, [selected, title, kind, country, lookupAccount]);
  const add = () => {
    const normalized = safeAvailabilityUrl(url.trim());
    if (!label.trim() || label.trim().length > 80 || !normalized || normalized.length > 2048) { setMessage('Enter a name and a valid http or https link.'); return; }
    if (!editing && links.length >= 30) { setMessage('An entry can have up to 30 personal links.'); return; }
    const item = { id: editing ?? crypto.randomUUID(), label: label.trim(), url: normalized };
    onLinks(editing ? links.map(link => link.id === editing ? item : link) : [...links, item]); setEditing(null); setLabel(''); setUrl(''); setMessage('');
  };
  const available = (Array.isArray(data?.links) ? data.links : []).filter(link => link && typeof link.name === 'string' && typeof link.kind === 'string' && typeof link.url === 'string' && safeAvailabilityUrl(link.url)).reduce<Link[]>((all, link) => {
    const existing = all.find(item => item.name === link.name && item.url === link.url);
    if (existing) { if (!existing.kind.split(' · ').includes(link.kind)) existing.kind += ` · ${link.kind}`; }
    else all.push({ ...link });
    return all;
  }, []);
  const icons: {name:string;logo?:string;url?:string;mode?:'direct'|'search'}[] = [];
  const iconKey=providerKey;
  if (kind === 'game' && lookupAccount && selected && confirmedMatch(preferred,title,kind)?.id === selected.id && typeof data?.matchedTitle === 'string' && normalizeTitle(data.matchedTitle) === normalizeTitle(selected.title)) {
    for (const link of available) { const direct = gameStoreUrl(link.name, link.url); if (direct && !icons.some(icon => iconKey(icon.name)===iconKey(link.name))) icons.push({name:link.name,url:direct,mode:'direct'}); }
  }
  if (watchmode && lookupAccount && watchmodeOwner === lookupAccount && watchmode.region === country && watchmode.mediaType === kind && watchmode.externalId === selected?.id && selected && confirmedMatch(preferred,title,kind ?? '')?.id === selected.id) {
    for (const candidate of watchmode.candidates.filter(item => item.verified === true)) {
      if (!icons.some(icon => iconKey(icon.name) === iconKey(candidate.name))) icons.push({name:candidate.name,url:candidate.titleUrl,mode:'direct'});
    }
  }

  for (const link of available) {
    const existing=icons.find(item=>iconKey(item.name)===iconKey(link.name));
    if(existing){existing.logo=link.logo;continue;}
    const target=providerTarget(link.name,title,kind??'',link.url,links);
    if (target) icons.push({name:link.name,logo:link.logo,url:target.url,mode:target.mode});
  }
  return <section className="availability availability-compact" aria-label="Availability and links">
    <div className="availability-icon-row" aria-label="Platforms">{icons.map(item=>{
      const icon=<PlatformIcon name={item.name} logo={item.logo}/>;
      return item.url?<a key={iconKey(item.name)} href={item.url} target="_blank" rel="noopener noreferrer" title={`${item.mode==='search'?'Search':'Open'} ${item.name}`} aria-label={`${item.mode==='search'?'Search':'Open'} ${item.name} for ${title}`}>{icon}</a>:<button type="button" key={iconKey(item.name)} title={`Add ${item.name} link`} aria-label={`Add a direct ${item.name} link`} onClick={()=>{setDetailsOpen(true);setLabel(item.name);setMessage('Add a direct link below.');}}>{icon}</button>;
    })}<button type="button" className="availability-settings" aria-label="Manage availability and links" aria-expanded={detailsOpen} onClick={()=>setDetailsOpen(value=>!value)} title="Manage availability and links"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg></button></div>
    {watchmode && lookupAccount && watchmodeOwner===lookupAccount && watchmode.region===country && watchmode.externalId===selected?.id && watchmode.candidates.some(item=>item.verified === true) && <small>Links provided by <a href="https://www.watchmode.com/" target="_blank" rel="noopener noreferrer">Watchmode</a></small>}
    {!lookupAccount && (kind==='movie'||kind==='tv'||kind==='game') && <small>Sign in under Settings to see platform links.</small>}
    <div className="availability-status" aria-live="polite">{kind&&country.length===2&&state==='loading'&&<small>Finding platforms…</small>}{state==='error'&&<small>Couldn’t check availability. <button type="button" onClick={()=>setRetry(value=>value+1)}>Try again</button></small>}{kind&&state==='ready'&&!selected&&matches.length>0&&<button type="button" onClick={()=>setDetailsOpen(true)}>Choose the right title</button>}{kind&&state==='ready'&&!selected&&!matches.length&&<small>No matching title found.</small>}</div>
    {detailsOpen&&<div className="availability-management">
      {kind&&<label>Region <input aria-label="Availability region, two-letter country code" maxLength={2} value={country} onChange={event=>{const value=event.target.value.toUpperCase().replace(/[^A-Z]/g,'').slice(0,2);setCountry(value);if(value.length===2)try{localStorage.setItem(regionKey,value);window.dispatchEvent(new Event('stillroom-region-change'))}catch{/* preference remains in memory */}}}/></label>}
      {kind&&country.length!==2&&<small>Enter a two-letter country code.</small>}
      {matches.length>0&&!selected&&<div className="availability-matches"><small>Choose the right title</small>{matches.map(match=><button type="button" key={match.id} onClick={()=>{setSelected(match);onPreferred({...match,mediaType:kind!,query:title});}}>{match.title}{match.year?` (${match.year})`:''}</button>)}</div>}
      {selected&&<div className="availability-selected"><small>{selected.title}{selected.year?` (${selected.year})`:''}</small><button type="button" onClick={()=>{setSelected(null);setData(null);setState('loading');void request(title,kind!,country).then(result=>{setMatches(Array.isArray(result.matches)?result.matches.filter(item=>item && /^\d+$/.test(item.id) && typeof item.title==='string'):[]);setState('ready')}).catch(()=>setState('error'));}}>Change match</button></div>}
      {kind&&state==='ready'&&watchmodeState!=='loading'&&selected&&!available.length&&!watchmode?.candidates.some(candidate=>candidate.verified)&&<small>No providers found for this title{kind==='game'?'':` in ${country}`}.</small>}
      {kind&&<p className="availability-source">{kind==='game'?'Game data provided by IGDB.':'Availability data provided by JustWatch via TMDB. Provider icons appear only when a direct title link is verified.'}</p>}
      {watchmodeState==='loading'&&<small>Checking direct links…</small>}{watchmodeState==='error'&&<small>Direct links are unavailable.</small>}
      {links.length>0&&<div className="personal-links">{links.map(link=><div key={link.id}><a href={safeAvailabilityUrl(link.url)} target="_blank" rel="noopener noreferrer">{link.label} ↗</a><button type="button" aria-label={`Edit ${link.label}`} onClick={()=>{setEditing(link.id);setLabel(link.label);setUrl(link.url);}}>Edit</button><button type="button" aria-label={`Remove ${link.label}`} onClick={()=>onLinks(links.filter(item=>item.id!==link.id))}>Remove</button></div>)}</div>}
      <div className="personal-link-form"><strong>{editing?'Edit link':'Add a direct link'}</strong><label>Name<input value={label} onChange={event=>setLabel(event.target.value)} maxLength={80} placeholder="e.g. Netflix"/></label><label>Link<input value={url} onChange={event=>setUrl(event.target.value)} type="url" placeholder="https://…" maxLength={2048}/></label><button type="button" onClick={add}>{editing?'Update link':'Add link'}</button>{editing&&<button type="button" onClick={()=>{setEditing(null);setLabel('');setUrl('');}}>Cancel</button>}{message&&<small role="alert">{message}</small>}</div>
    </div>}
  </section>;
}
