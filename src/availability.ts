/** Conservative helpers shared by provider lookup and its UI. */
export type AvailabilityMatch = { id: string; title: string; year?: number; artworkUrl?: string };
export type PersonalLink = { id: string; label: string; url: string };
export type ChosenMatch = AvailabilityMatch & { mediaType: string; query: string };
export type MatchDecision = { kind: 'none' } | { kind: 'automatic'; match: AvailabilityMatch } | { kind: 'choose'; matches: AvailabilityMatch[] };
export type ProviderTarget = { url:string; mode:'direct'|'search' };

/** A provider search is clearly labelled; never claim it is a title deep link. */
export function providerKey(value:string):string {
    const n = value.trim().toLowerCase();
    if (n.startsWith('netflix')) return 'netflix';
    if (n === 'amazon prime video' || n === 'prime video' || n === 'amazon video') return 'prime video';
    return n;
}
// The current upstream does not provide verified provider title destinations.
// Preserve personal links in storage and the link manager, but do not present
// an unverified URL as a platform icon.
export function providerTarget(_name:string, _title:string, _type:string, _automaticUrl:string|undefined, _personal:PersonalLink[]): ProviderTarget | undefined {
  return undefined;
}

/** Only a direct Steam app page from the confirmed game record is supported. */
export function gameStoreUrl(name: string, value: string): string | undefined {
  try {
    const url = new URL(value);
    if (name.toLowerCase() !== 'steam' || url.protocol !== 'https:' || url.hostname !== 'store.steampowered.com' || url.port || url.username || url.password || !/^\/app\/\d+\/?$/.test(url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

/** Only a single exact title is safe to select without asking the user. */
export function chooseMatch(query: string, matches: AvailabilityMatch[]): MatchDecision {
  const wanted = normalizeTitle(query);
  if (!wanted || !matches.length) return { kind: 'none' };
  const exact = matches.filter(match => normalizeTitle(match.title) === wanted);
  if (exact.length === 1) return { kind: 'automatic', match: exact[0] };
  return { kind: 'choose', matches: exact.length > 1 ? exact : matches };
}

/** A confirmed provider ID is independent of subsequent search ranking. */
export function confirmedMatch(match: ChosenMatch | undefined, title: string, mediaType: string): AvailabilityMatch | undefined {
  if (!match || match.mediaType !== mediaType || match.query !== title) return undefined;
  return { id: match.id, title: match.title, ...(match.year === undefined ? {} : { year: match.year }) };
}

/** Links from a provider or a person are untrusted; only web URLs are usable. */
export function safeAvailabilityUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function parsePersonalLinks(value: unknown): PersonalLink[] | undefined {
  if (!Array.isArray(value) || value.length > 30) return undefined;
  const result: PersonalLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const { id, label, url } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id || id.length > 100 || typeof label !== 'string' || !label.trim() || label.length > 80 || typeof url !== 'string' || url.length > 2048 || !safeAvailabilityUrl(url)) return undefined;
    result.push({ id, label, url });
  }
  return result;
}
export function parseChosenMatch(value: unknown): ChosenMatch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !/^\d{1,12}$/.test(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300 || typeof item.query !== 'string' || item.query.length > 300 || typeof item.mediaType !== 'string' || !['movie','tv','game'].includes(item.mediaType) || (item.year !== undefined && (!Number.isInteger(item.year) || (item.year as number) < 1800 || (item.year as number) > 2200))) return undefined;
  return { id:item.id, title:item.title, query:item.query, mediaType:item.mediaType, ...(item.year === undefined ? {} : {year:item.year as number}) };
}
