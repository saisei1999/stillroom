import type { ChosenMatch } from './availability';
export type Artwork = { url: string; title: string; source: string; providerMatch?: ChosenMatch };
type Provider = 'itunes' | 'tvmaze' | 'openlibrary' | 'wikipedia';
const words = (text: string) => text.toLocaleLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(word => word && !['the', 'a', 'an', 'of'].includes(word));
export function relevance(query: string, title: string): number {
  const wanted = words(query), got = words(title);
  if (!wanted.length) return 0;
  return wanted.filter((word, index) => got.includes(word) || (index === wanted.length - 1 && got.some(candidate => candidate.startsWith(word)))).length / wanted.length;
}
async function request(url: string, signal: AbortSignal): Promise<any> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Artwork service returned ${response.status}`);
  return response.json();
}
async function searchProvider(provider: Provider, query: string, type: string, signal: AbortSignal): Promise<Artwork[]> {
  const q = encodeURIComponent(query);
  if (provider === 'wikipedia') {
    const search = `${query} ${type === 'Movie' ? 'film' : type === 'TV / Anime' ? 'anime' : type === 'Manga' ? 'manga' : type === 'Game' ? 'video game' : type === 'Music' ? 'album' : 'book'}`;
    const data = await request(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(search)}&gsrlimit=8&prop=pageimages&piprop=thumbnail&pilicense=any&pithumbsize=600&format=json&origin=*`, signal);
    return Object.values(data.query?.pages ?? {}).map((item: any) => ({ title: item.title ?? '', url: item.thumbnail?.source ?? '', source: 'Wikipedia' }));
  }
  if (provider === 'tvmaze') {
    const data = await request(`https://api.tvmaze.com/search/shows?q=${q}`, signal);
    return data.map((item: any) => ({ title: item.show?.name ?? '', url: item.show?.image?.original ?? item.show?.image?.medium ?? '', source: 'TVmaze' }));
  }
  if (provider === 'openlibrary') {
    const data = await request(`https://openlibrary.org/search.json?title=${q}&fields=title,cover_i&limit=8`, signal);
    return (data.docs ?? []).filter((item: any) => item.cover_i).map((item: any) => ({ title: item.title, url: `https://covers.openlibrary.org/b/id/${item.cover_i}-L.jpg`, source: 'Open Library' }));
  }
  const media = type === 'Movie' ? 'movie' : type === 'Music' ? 'music' : 'software';
  const data = await request(`https://itunes.apple.com/search?term=${q}&media=${media}&limit=12`, signal);
  return (data.results ?? []).map((item: any) => ({ title: item.trackName ?? item.collectionName ?? '', url: (item.artworkUrl100 ?? '').replace('100x100bb', '600x600bb'), source: 'Apple iTunes' }));
}
export async function searchArtwork(query: string, type: string, signal: AbortSignal): Promise<Artwork[]> {
  const primary: Provider[] = type === 'TV / Anime' ? ['tvmaze'] : type === 'Book' || type === 'Manga' ? ['openlibrary'] : ['itunes'];
  const outcomes = await Promise.allSettled([...primary, 'wikipedia' as Provider].map(provider => searchProvider(provider, query, type, signal)));
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const found = outcomes.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const unique = new Map<string, Artwork>();
  for (const result of found) if (/^https:\/\//i.test(result.url) && relevance(query, result.title) >= .6 && !unique.has(result.url)) unique.set(result.url, result);
  if (!unique.size && outcomes.every(outcome => outcome.status === 'rejected')) throw new Error('Artwork services unavailable');
  return [...unique.values()].sort((a, b) => relevance(query, b.title) - relevance(query, a.title)).slice(0, 8);
}

