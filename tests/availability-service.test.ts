import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let handler: (request: Request) => Promise<Response>;
let allowBudget = true;
let watchmodeFails = false;
let watchmodeBudget: boolean | null = true;
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/auth/v1/user')) return (init?.headers as Record<string,string>)?.Authorization === 'Bearer user-token' ? Response.json({id:'user-1',is_anonymous:false}) : (init?.headers as Record<string,string>)?.Authorization === 'Bearer anonymous-user-token' ? Response.json({id:'guest-1',is_anonymous:true}) : new Response('', {status:401});
  if (url.includes('stillroom_take_availability_budget')) return Response.json(allowBudget);
  if (url.includes('stillroom_take_watchmode_budget')) return watchmodeBudget === null ? new Response('', { status: 503 }) : Response.json(watchmodeBudget);
  if (url.includes('api.watchmode.com')) return watchmodeFails ? new Response('', { status: 400 }) : Response.json([{ source_id: 1, name: 'Netflix', region: 'US', type: 'sub', web_url: 'https://www.netflix.com/title/123' }, { source_id: 2, name: 'Netflix', region: 'GB', type: 'sub', web_url: 'https://www.netflix.com/title/456' }]);
  if (url.includes('/search/movie')) return Response.json({ results: [{ id: 12, title: 'Example', release_date: '2020-01-01', poster_path: '/poster.jpg' }] });
  if (url.includes('/watch/providers')) return Response.json({ results: { US: { link: 'https://www.themoviedb.org/movie/12/watch', flatrate: [{ provider_name: 'Example streaming', logo_path: '/logo.png' }] } } });
  if (url.includes('id.twitch.tv')) return Response.json({ access_token: 'fake', expires_in: 1000 });
  if (url.includes('api.igdb.com')) return Response.json([{ id: 55, name: 'Example game', websites: [{ url: 'https://store.steampowered.com/app/55' }, { url: 'https://evil.example/app/55' }] }]);
  return new Response('', { status: 500 });
});
const get = (query:string, origin = 'https://saisei1999.github.io', token = 'user-token') => handler(new Request(`https://example.test/?${query}`, { headers: { origin, ...(token ? {authorization:`Bearer ${token}`} : {}) } }));
beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Deno', { env: { get: (key:string) => ({ SUPABASE_URL:'https://example.test', SUPABASE_ANON_KEY:'fake', TMDB_API_KEY:'fake', WATCHMODE_API_KEY:'private-test-key', TWITCH_CLIENT_ID:'fake', TWITCH_CLIENT_SECRET:'fake' } as Record<string,string>)[key] }, serve: (fn:typeof handler) => { handler = fn; } });
  await import('../supabase/functions/media-availability/index');
});
afterAll(() => vi.unstubAllGlobals());
describe('availability service', () => {
  it('rejects malformed requests and unknown origins', async () => {
    expect((await get('type=game&title=x&id=1%3Bdelete')).status).toBe(400);
    expect((await get('type=movie&title=x', 'https://elsewhere.example')).status).toBe(403);
    expect((await get('type=movie&title=x', 'http://127.0.0.1:5182')).status).toBe(200);
  });
  it('fails closed when the shared quota is exhausted', async () => {
    allowBudget = false;
    expect((await get('type=movie&title=Example')).status).toBe(429);
    allowBudget = true;
  });
  it('returns movie matches and labelled availability without a secret', async () => {
    const match = await (await get('type=movie&title=Example')).json();
    expect(match.matches[0]).toEqual({ id:'12', title:'Example', year:2020, artworkUrl:'https://image.tmdb.org/t/p/w500/poster.jpg' });
    const providers = await (await get('type=movie&title=Example&id=12')).json();
    expect(providers.links[0]).toMatchObject({ name:'Example streaming', kind:'Subscription' });
    expect(JSON.stringify(providers)).not.toContain('fake');
  });
  it('rejects anonymous or invalid sessions before Watchmode', async () => {
    const before = fetchMock.mock.calls.filter(call => String(call[0]).includes('api.watchmode.com')).length;
    const query = 'type=tv&title=Suits&id=37680&region=US&source=watchmode';
    expect((await get(query, 'https://saisei1999.github.io', '')).status).toBe(401);
    expect((await get(query, 'https://saisei1999.github.io', 'invalid')).status).toBe(401);
    expect((await get(query, 'https://saisei1999.github.io', 'anonymous-user-token')).status).toBe(401);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('api.watchmode.com'))).toHaveLength(before);
  });
  it('returns region-scoped Watchmode candidates without exposing the key', async () => {
    const result = await (await get('type=tv&title=Suits&id=37680&region=US&source=watchmode')).json();
    expect(result).toMatchObject({ source:'Watchmode', mediaType:'tv', externalId:'37680', region:'US' });
    expect(result.candidates).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private-test-key');
    const call = fetchMock.mock.calls.map(call => String(call[0])).find(url => url.includes('api.watchmode.com'))!;
    expect(new URL(call).pathname).toBe('/v1/title/tv-37680/sources/');
    expect(new URL(call).searchParams.get('regions')).toBe('US');
    expect(new URL(call).searchParams.has('apiKey')).toBe(false);
    const upstream = fetchMock.mock.calls.find(entry => String(entry[0]).includes('api.watchmode.com'));
    expect((upstream?.[1]?.headers as Record<string,string>)['X-API-Key']).toBe('private-test-key');
    const budget = fetchMock.mock.calls.find(entry => String(entry[0]).includes('stillroom_take_watchmode_budget'));
    expect((budget?.[1]?.headers as Record<string,string>).Authorization).toBe('Bearer user-token');
  });
  it('fails safely for unsupported regions or malformed Watchmode requests', async () => {
    expect((await get('type=tv&title=Suits&source=watchmode')).status).toBe(400);
    watchmodeFails = true;
    expect((await get('type=tv&title=Suits&id=37680&region=GB&source=watchmode')).status).toBe(502);
    watchmodeFails = false;
  });
  it('never calls Watchmode when its budget is exhausted or unavailable', async () => {
    const before = fetchMock.mock.calls.filter(call => String(call[0]).includes('api.watchmode.com')).length;
    watchmodeBudget = false;
    expect((await get('type=tv&title=Suits&id=37681&region=US&source=watchmode')).status).toBe(429);
    watchmodeBudget = null;
    expect((await get('type=tv&title=Suits&id=37681&region=US&source=watchmode')).status).toBe(502);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('api.watchmode.com'))).toHaveLength(before);
    watchmodeBudget = true;
  });
  it('shares simultaneous lookups, caches successes, and separates regions and IDs', async () => {
    const before = fetchMock.mock.calls.filter(call => String(call[0]).includes('api.watchmode.com')).length;
    const q = 'type=tv&title=Example&id=88881&region=US&source=watchmode';
    const responses = await Promise.all([get(q), get(q), get(q)]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect((await get(q)).status).toBe(200);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('api.watchmode.com')).length - before).toBe(1);
    await get('type=tv&title=Example&id=88881&region=GB&source=watchmode');
    await get('type=tv&title=Example&id=88882&region=US&source=watchmode');
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('api.watchmode.com')).length - before).toBe(3);
  });
  it('does not cache upstream failures', async () => {
    const before = fetchMock.mock.calls.filter(call => String(call[0]).includes('api.watchmode.com')).length;
    watchmodeFails = true;
    const q = 'type=movie&title=Example&id=88883&region=US&source=watchmode';
    expect((await get(q)).status).toBe(502);
    expect((await get(q)).status).toBe(502);
    watchmodeFails = false;
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('api.watchmode.com')).length - before).toBe(2);
  });
  it('requires sign-in for game storefront links', async () => {
    expect((await get('type=game&title=Example&id=55', 'https://saisei1999.github.io', '')).status).toBe(401);
  });
  it('only returns recognized game storefront links', async () => {
    const result = await (await get('type=game&title=Example&id=55')).json();
    expect(result.links).toEqual([{ name:'Steam', url:'https://store.steampowered.com/app/55', kind:'Store link' }]);
  });
});
