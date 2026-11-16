import { watchmodeCandidates, type WatchmodeCandidate } from './watchmode.ts';

// Only resolve a series when Watchmode itself reports a direct Crunchyroll
// episode in the requested region. Wikidata supplies identity, not availability.
export async function crunchyrollSeriesFallback(rows: unknown[], region: string, tmdbId: string): Promise<{candidates: WatchmodeCandidate[]; retryable: boolean}> {
  if (!/^\d{1,12}$/.test(tmdbId)) return {candidates: [], retryable: false};
  const source = rows.find((row: any) => {
    if (!row || !Number.isSafeInteger(row.source_id) || row.source_id < 1 || !['crunchyroll', 'crunchyroll premium'].includes(String(row.name).trim().toLowerCase()) || row.region !== region || !['sub', 'free'].includes(row.type) || typeof row.web_url !== 'string') return false;
    try { const url = new URL(row.web_url); return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['crunchyroll.com','www.crunchyroll.com'].includes(url.hostname.toLowerCase()) && /^\/watch\/[A-Z0-9]{9,10}(?:\/[a-z0-9-]+)?\/?$/i.test(url.pathname); } catch { return false; }
  }) as Record<string, unknown> | undefined;
  if (!source) return {candidates: [], retryable: false};
  const get = async (url: URL) => {
    const response = await fetch(url, {headers: {'User-Agent': 'Stillroom/0.1.0 (https://github.com/saisei1999/stillroom)'}, signal: AbortSignal.timeout(1500)});
    if (!response.ok) throw new Error('Wikidata unavailable');
    return await response.json();
  };
  try {
    const search = new URL('https://www.wikidata.org/w/api.php');
    search.search = new URLSearchParams({action:'query', list:'search', srsearch:`haswbstatement:P4983=${tmdbId}`, srlimit:'2', format:'json'}).toString();
    const result = await get(search);
    if (result?.query?.searchinfo?.totalhits !== 1 || !Array.isArray(result?.query?.search) || result.query.search.length !== 1 || !/^Q[1-9]\d*$/.test(result.query.search[0]?.title ?? '')) return {candidates: [], retryable: false};
    const entityId = result.query.search[0].title;
    const entityUrl = new URL('https://www.wikidata.org/w/api.php');
    entityUrl.search = new URLSearchParams({action:'wbgetentities', ids:entityId, props:'claims', format:'json'}).toString();
    const entity = (await get(entityUrl))?.entities?.[entityId];
    const values = (property: string) => (Array.isArray(entity?.claims?.[property]) ? entity.claims[property] : []).filter((claim: any) => claim?.rank !== 'deprecated' && claim?.mainsnak?.snaktype === 'value').map((claim: any) => claim?.mainsnak?.datavalue?.value).filter((value: unknown) => typeof value === 'string');
    const tmdbIds = [...new Set(values('P4983'))];
    const seriesIds = [...new Set(values('P11330'))];
    if (tmdbIds.length !== 1 || tmdbIds[0] !== tmdbId || seriesIds.length !== 1 || !/^[A-Z0-9]{9,10}$/.test(seriesIds[0] as string)) return {candidates: [], retryable: false};
    return {candidates: watchmodeCandidates([{...source, web_url:`https://www.crunchyroll.com/series/${seriesIds[0]}`}], region), retryable: false};
  } catch { return {candidates: [], retryable: true}; }
}
