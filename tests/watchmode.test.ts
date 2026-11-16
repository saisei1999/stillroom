import { describe, expect, it } from 'vitest';
import { watchmodeCandidates } from '../src/watchmode';

describe('Watchmode source candidates', () => {
  const row = { source_id: 1, name: 'Netflix', region: 'US', type: 'sub', web_url: 'https://www.netflix.com/title/123' };
  it('retains a regional title-link candidate and offer type', () => {
    expect(watchmodeCandidates([row], 'US')).toEqual([{ sourceId: 1, name: 'Netflix', region: 'US', offerType: 'sub', titleUrl: row.web_url, verified: true }]);
    expect(watchmodeCandidates([row], 'GB')).toEqual([]);
  });
  it('accepts narrow provider routes from the Suits and Dune benchmark', () => {
    const suits = {...row, web_url:'https://www.netflix.com/title/70283145'};
    const oldDune = {...row, name:'AppleTV', type:'rent', web_url:'https://tv.apple.com/us/movie/dune/umc.cmc.7edgw5obp2gwx0xsyhla10zbc'};
    const newDune = {...row, name:'AppleTV', type:'buy', web_url:'https://tv.apple.com/us/movie/dune/umc.cmc.2l7qj9p33t3jww1roxi8cgiw5'};
    const candidates = watchmodeCandidates([suits, oldDune, newDune], 'US');
    expect(candidates.map(item => item.titleUrl)).toEqual([suits.web_url, oldDune.web_url, newDune.web_url]);
    expect(candidates[1].titleUrl).not.toBe(candidates[2].titleUrl);
    expect(watchmodeCandidates([{...oldDune, web_url:'https://tv.apple.com/us/search?term=dune'}], 'US')).toEqual([]);
    expect(watchmodeCandidates([{...row, web_url:'https://www.netflix.com/browse/genre/1'}], 'US')).toEqual([]);
    expect(watchmodeCandidates([{...row, type:'unknown'}], 'US')).toEqual([]);
  });
  it('rejects search, home, spoofed domains, unsafe URLs, and missing links', () => {
    for (const web_url of ['https://www.netflix.com/search?q=title', 'https://www.netflix.com/', 'https://netflix.com.evil.example/title/1', 'javascript:alert(1)', 'https://user@netflix.com/title/1', null]) {
      expect(watchmodeCandidates([{...row, web_url}], 'US')).toEqual([]);
    }
  });
});
