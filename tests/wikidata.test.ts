import { afterEach, describe, expect, it, vi } from 'vitest';
import { crunchyrollSeriesFallback } from '../supabase/functions/media-availability/wikidata';

const episode = {source_id: 1, name:'Crunchyroll Premium', region:'US', type:'sub', web_url:'https://www.crunchyroll.com/watch/GJWUQ2038'};
const claim = (value: string, rank = 'normal') => ({rank, mainsnak:{snaktype:'value', datavalue:{value}}});
function mockWikidata(options: {hits?: number; tmdb?: string[]; series?: string[]; fail?: boolean} = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: URL) => {
    if (options.fail) throw new Error('offline');
    const url = new URL(String(input));
    if (url.searchParams.get('action') === 'query') return Response.json({query:{searchinfo:{totalhits:options.hits ?? 1}, search:[{title:'Q22126305'}]}});
    return Response.json({entities:{Q22126305:{claims:{P4983:(options.tmdb ?? ['1429']).map(x=>claim(x)), P11330:(options.series ?? ['GR751KNZY']).map(x=>claim(x))}}}});
  }));
}
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
describe('Crunchyroll series identity fallback', () => {
  it('uses a uniquely matched TMDB and Crunchyroll ID only with a regional Watchmode source', async () => {
    mockWikidata();
    const result = await crunchyrollSeriesFallback([episode], 'US', '1429');
    expect(result.candidates).toMatchObject([{name:'Crunchyroll Premium', region:'US', titleUrl:'https://www.crunchyroll.com/series/GR751KNZY', verified:true}]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
  it('does not query Wikidata for unavailable regions, third-party channels or spoofed episode links', async () => {
    mockWikidata();
    for (const item of [{...episode,region:'GB'}, {...episode,name:'Crunchyroll Premium (Via Prime) Amazon Channel'}, {...episode,web_url:'https://crunchyroll.com.evil.test/watch/GJWUQ2038'}]) expect((await crunchyrollSeriesFallback([item], 'US', '1429')).candidates).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('hides ambiguous, mismatched and malformed identities', async () => {
    for (const options of [{hits:2}, {tmdb:['111']}, {tmdb:['1429','111']}, {series:['GR751KNZY','GR1234567']}, {series:['../../bad']}]) {
      mockWikidata(options);
      expect((await crunchyrollSeriesFallback([episode], 'US', '1429')).candidates).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
  it('fails safely and marks transient failures retryable', async () => {
    mockWikidata({fail:true});
    expect(await crunchyrollSeriesFallback([episode], 'US', '1429')).toEqual({candidates:[],retryable:true});
  });
});
