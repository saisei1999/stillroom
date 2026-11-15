import { afterEach, describe, expect, it, vi } from 'vitest';
import { relevance, searchArtwork } from '../src/artwork-search';
afterEach(() => vi.unstubAllGlobals());
describe('artwork lookup', () => {
  it('prefers titles containing the important query words', () => {
    expect(relevance('The Legend of Hei', 'The Legend of Hei')).toBe(1);
    expect(relevance('The Legend of Hei', 'Another legend')).toBeLessThan(.6);
  });
  it('finds a matching Wikipedia cover when the primary service fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('itunes')) throw new Error('offline');
      return { ok: true, json: async () => ({ query: { pages: { a: { title: 'The Legend of Hei', thumbnail: { source: 'https://upload.wikimedia.org/poster.jpg' } }, b: { title: 'Unrelated movie', thumbnail: { source: 'https://example.com/wrong.jpg' } } } } }) };
    }));
    expect(await searchArtwork('The Legend of Hei', 'Movie', new AbortController().signal)).toEqual([{ title: 'The Legend of Hei', url: 'https://upload.wikimedia.org/poster.jpg', source: 'Wikipedia' }]);
  });
});
