import { watchmodeCandidates } from './watchmode.ts';
import { crunchyrollSeriesFallback } from './wikidata.ts';
// The browser never receives provider credentials. This function exposes only
// title lookup and store metadata, not an arbitrary upstream proxy.
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
export {};
const origins = new Set(['https://saisei1999.github.io', 'http://127.0.0.1:5173', 'http://127.0.0.1:5176', 'http://127.0.0.1:5182', 'http://localhost:5173', 'http://localhost:5176']);
let token: { value: string; expires: number } | undefined;
// Best-effort per-instance guard, not a substitute for a shared gateway limit.
let windowStarted = Date.now(), requestsInWindow = 0;
const response = (body: unknown, status: number, origin: string) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Cache-Control': 'no-store' } });
async function json(url: string, init?: RequestInit) {
  const result = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!result.ok) throw new Error('upstream unavailable');
  return await result.json();
}
async function igdbToken() {
  if (token && token.expires > Date.now() + 60000) return token.value;
  const id = Deno.env.get('TWITCH_CLIENT_ID'), secret = Deno.env.get('TWITCH_CLIENT_SECRET');
  if (!id || !secret) throw new Error('not configured');
  const params = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' });
  const result = await json('https://id.twitch.tv/oauth2/token', { method: 'POST', body: params });
  token = { value: result.access_token, expires: Date.now() + result.expires_in * 1000 };
  return token.value;
}
async function gameQuery(body: string) {
  return json('https://api.igdb.com/v4/games', { method: 'POST', headers: { 'Client-ID': Deno.env.get('TWITCH_CLIENT_ID')!, Authorization: `Bearer ${await igdbToken()}`, 'Content-Type': 'text/plain' }, body });
}
async function takeBudget(): Promise<boolean> {
  const project = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!project || !anon) throw new Error('budget unavailable');
  const result = await fetch(`${project}/rest/v1/rpc/stillroom_take_availability_budget`, { method: 'POST', headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(4000) });
  if (!result.ok) throw new Error('budget unavailable');
  return (await result.json()) === true;
}
async function takeWatchmodeBudget(token: string): Promise<boolean> {
  const project = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!project || !anon) throw new Error('budget unavailable');
  const result = await fetch(`${project}/rest/v1/rpc/stillroom_take_watchmode_budget`, { method: 'POST', headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(4000) });
  if (!result.ok) throw new Error('budget unavailable');
  return (await result.json()) === true;
}
async function signedInUser(request: Request): Promise<string | undefined> {
  const project = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY');
  const authorization = request.headers.get('authorization');
  if (!project || !anon || !authorization || !/^Bearer [^\s]+$/i.test(authorization)) return undefined;
  const result = await fetch(`${project}/auth/v1/user`, { headers: { apikey: anon, Authorization: authorization }, signal: AbortSignal.timeout(4000) });
  if (!result.ok) return undefined;
  const user = await result.json();
  return typeof user?.id === 'string' && user.id && user.is_anonymous !== true ? authorization.slice(7) : undefined;
}
class WatchmodeBudgetExhausted extends Error {}
type WatchmodeResult = { candidates: ReturnType<typeof watchmodeCandidates>; source: 'Watchmode'; mediaType: string; externalId: string; region: string; retryable?: boolean };
const watchmodeCache = new Map<string, { at: number; value: WatchmodeResult }>();
const watchmodePending = new Map<string, Promise<WatchmodeResult>>();
async function lookupWatchmode(type: string, id: string, region: string, token: string): Promise<WatchmodeResult> {
  const cacheKey = JSON.stringify([type, id, region]);
  const cached = watchmodeCache.get(cacheKey);
  if (cached && Date.now() >= cached.at && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.value;
  watchmodeCache.delete(cacheKey);
  const pending = watchmodePending.get(cacheKey);
  if (pending) return pending;
  const operation = (async () => {
    const key = Deno.env.get('WATCHMODE_API_KEY');
    if (!key) throw new Error('not configured');
    if (!await takeWatchmodeBudget(token)) throw new WatchmodeBudgetExhausted();
    const url = new URL(`https://api.watchmode.com/v1/title/${type}-${id}/sources/`);
    url.searchParams.set('regions', region);
    const data = await json(url.href, { headers: { 'X-API-Key': key } });
    if (!Array.isArray(data)) throw new Error('invalid provider response');
    const candidates = watchmodeCandidates(data, region);
    const fallback = type === 'tv' && !candidates.some(item => /^crunchyroll(?: premium)?$/i.test(item.name.trim())) ? await crunchyrollSeriesFallback(data, region, id) : {candidates: [], retryable: false};
    const value: WatchmodeResult = { candidates: [...candidates, ...fallback.candidates], source: 'Watchmode', mediaType: type, externalId: id, region, ...(fallback.retryable ? {retryable:true} : {}) };
    if (!fallback.retryable) { if (watchmodeCache.size >= 100) watchmodeCache.delete(watchmodeCache.keys().next().value!); watchmodeCache.set(cacheKey, { at: Date.now(), value }); }
    return value;
  })();
  watchmodePending.set(cacheKey, operation);
  try { return await operation; } finally { watchmodePending.delete(cacheKey); }
}
Deno.serve(async (request: Request) => {
  const origin = request.headers.get('origin') ?? '';
  if (!origins.has(origin)) return response({ error: 'Origin not allowed' }, 403, 'null');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' } });
  if (request.method !== 'GET') return response({ error: 'Method not allowed' }, 405, origin);
  if (Date.now() - windowStarted >= 60000) { windowStarted = Date.now(); requestsInWindow = 0; }
  if (++requestsInWindow > 120) return response({ error: 'Too many requests' }, 429, origin);
  const params = new URL(request.url).searchParams;
  const type = params.get('type'), title = params.get('title')?.trim(), region = params.get('region') ?? 'US', id = params.get('id');
  const source = params.get('source');
  if (source !== null && source !== 'watchmode') return response({ error: 'Invalid request' }, 400, origin);
  if (source === 'watchmode' && (!id || !['movie', 'tv'].includes(type ?? ''))) return response({ error: 'Invalid request' }, 400, origin);
  if (!['movie', 'tv', 'game'].includes(type ?? '') || !title || title.length > 160 || !/^[A-Z]{2}$/.test(region) || (id !== null && !/^\d{1,12}$/.test(id))) return response({ error: 'Invalid request' }, 400, origin);
  try {
    if (!await takeBudget()) return response({ error: 'Too many requests' }, 429, origin);
    if (source === 'watchmode') {
      const token = await signedInUser(request);
      if (!token) return response({ error: 'Sign in required' }, 401, origin);
      return response(await lookupWatchmode(type!, id!, region, token), 200, origin);
    }
    if (type === 'game') {
      if (id && !await signedInUser(request)) return response({ error: 'Sign in required' }, 401, origin);
      const query = id ? `where id = ${id}; fields name,first_release_date,websites.url; limit 1;` : `search ${JSON.stringify(title)}; fields name,first_release_date; limit 10;`;
      const games = await gameQuery(query);
      if (!id) return response({ matches: games.map((g: {id:number;name:string;first_release_date?:number}) => ({ id: String(g.id), title: g.name, year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : undefined })) }, 200, origin);
      const hosts: Record<string, string> = { 'store.steampowered.com': 'Steam', 'store.epicgames.com': 'Epic Games', 'www.gog.com': 'GOG', 'gog.com': 'GOG', 'www.xbox.com': 'Xbox', 'www.playstation.com': 'PlayStation', 'store.playstation.com': 'PlayStation', 'www.nintendo.com': 'Nintendo', 'itch.io': 'itch.io' };
      const links = (games[0]?.websites ?? []).flatMap((site: {url?:string}) => { try { const url = new URL(site.url ?? ''); const host = url.hostname.toLowerCase(); const name = hosts[host] ?? (host.endsWith('.itch.io') ? 'itch.io' : undefined); return url.protocol === 'https:' && name ? [{ name, url: url.href, kind: 'Store link' }] : []; } catch { return []; } });
      return response({ links, source: 'IGDB', matchedTitle: games[0]?.name ?? '' }, 200, origin);
    }
    const key = Deno.env.get('TMDB_API_KEY');
    if (!key) throw new Error('not configured');
    const base = `https://api.themoviedb.org/3/${type}`;
    if (!id) {
      const search = new URL(`https://api.themoviedb.org/3/search/${type}`); search.searchParams.set('api_key', key); search.searchParams.set('query', title);
      const data = await json(search.href);
      return response({ matches: data.results.slice(0, 10).map((item: {id:number;title?:string;name?:string;release_date?:string;first_air_date?:string;poster_path?:string}) => ({ id: String(item.id), title: item.title ?? item.name, year: Number((item.release_date ?? item.first_air_date ?? '').slice(0, 4)) || undefined, ...(typeof item.poster_path === 'string' && /^\/[A-Za-z0-9_.-]+$/.test(item.poster_path) ? { artworkUrl: `https://image.tmdb.org/t/p/w500${item.poster_path}` } : {}) })) }, 200, origin);
    }
    const url = new URL(`${base}/${id}/watch/providers`); url.searchParams.set('api_key', key);
    const data = await json(url.href); const local = data.results?.[region];
    const categories: Record<string, string> = { flatrate: 'Subscription', free: 'Free', ads: 'With ads', rent: 'Rent', buy: 'Buy' };
    const providers = Object.entries(categories).flatMap(([key, kind]) => (local?.[key] ?? []).map((p: {provider_name:string;logo_path:string}) => ({ name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : undefined, kind, url: local.link })));
    return response({ links: providers, source: 'JustWatch', availabilityPage: local?.link }, 200, origin);
  } catch (error) { return error instanceof WatchmodeBudgetExhausted ? response({ error: 'Watchmode budget exhausted' }, 429, origin) : response({ error: 'Provider lookup unavailable' }, 502, origin); }
});
