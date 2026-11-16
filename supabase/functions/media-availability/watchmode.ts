/** Trust Watchmode’s confirmed-ID association after region, domain, and route validation. */
export type WatchmodeCandidate = { sourceId: number; name: string; region: string; offerType: string; titleUrl: string; verified?: boolean };
// Supported routes are intentionally narrow. These are candidates, not proof
// that a destination still identifies the requested film or series.
const routes: Record<string, { hosts: string[]; path: RegExp }> = {
  netflix: { hosts: ['www.netflix.com', 'netflix.com'], path: /^\/title\/\d+\/?$/ },
  appletv: { hosts: ['tv.apple.com'], path: /^\/[a-z]{2}\/(?:movie|show)\/[^/]+\/umc\.cmc\.[a-z0-9]+\/?$/i },
  tubi: { hosts: ['tubitv.com', 'www.tubitv.com'], path: /^\/(?:movies|series)\/\d+\/[a-z0-9][a-z0-9-]*\/?$/i },
  'tubi tv': { hosts: ['tubitv.com', 'www.tubitv.com'], path: /^\/(?:movies|series)\/\d+\/[a-z0-9][a-z0-9-]*\/?$/i },
  crunchyroll: { hosts: ['crunchyroll.com', 'www.crunchyroll.com'], path: /^\/series\/[A-Z0-9]{9}\/[a-z0-9][a-z0-9-]*\/?$/i },
  'crunchyroll premium': { hosts: ['crunchyroll.com', 'www.crunchyroll.com'], path: /^\/series\/[A-Z0-9]{9}\/[a-z0-9][a-z0-9-]*\/?$/i },
  amazon: { hosts: ['watch.amazon.com'], path: /^\/detail\/?$/ },
  'prime video': { hosts: ['watch.amazon.com'], path: /^\/detail\/?$/ },
  'amazon prime video': { hosts: ['watch.amazon.com'], path: /^\/detail\/?$/ },
  'hbo max': { hosts: ['play.hbomax.com'], path: /^\/show\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i },
  peacock: { hosts: ['peacocktv.com', 'www.peacocktv.com'], path: /^\/watch-online\/tv\/[a-z0-9][a-z0-9-]*\/\d+\/?$/i },
  hulu: { hosts: ['hulu.com', 'www.hulu.com'], path: /^\/(?:series|movie)\/(?:[a-z0-9-]+-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i },
  'disney+': { hosts: ['disneyplus.com', 'www.disneyplus.com'], path: /^\/(?:series|movies)\/[a-z0-9][a-z0-9-]*\/[a-z0-9]{10,16}\/?$/i },
};
export function watchmodeCandidates(payload: unknown, region: string): WatchmodeCandidate[] {
  if (!Array.isArray(payload) || !/^[A-Z]{2}$/.test(region)) return [];
  return payload.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    if (!Number.isSafeInteger(item.source_id) || (item.source_id as number) < 1 || typeof item.name !== 'string' || typeof item.type !== 'string' || !['sub','rent','buy','free','tve'].includes(item.type) || item.region !== region || typeof item.web_url !== 'string') return [];
    const route = routes[item.name.trim().toLowerCase()];
    if (!route) return [];
    try {
      const url = new URL(item.web_url);
      if (url.protocol !== 'https:' || url.username || url.password || !route.hosts.includes(url.hostname.toLowerCase()) || url.port || !route.path.test(url.pathname)) return [];
      if (url.hostname.toLowerCase() === 'watch.amazon.com' && (url.searchParams.getAll('gti').length !== 1 || !/^amzn1\.dv\.gti\.[0-9a-f-]{36}$/i.test(url.searchParams.get('gti') ?? ''))) return [];
      return [{ sourceId: item.source_id as number, name: item.name, region, offerType: item.type, titleUrl: url.href, verified: true }];
    } catch { return []; }
  });
}
