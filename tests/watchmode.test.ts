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
  it('accepts direct Tubi movie and series routes and rejects non-title destinations', () => {
    const movie = {...row, name:'Tubi TV', type:'free', web_url:'https://tubitv.com/movies/100002156/men-in-black'};
    const show = {...row, name:'Tubi', type:'free', web_url:'https://tubitv.com/series/300009030/suits'};
    expect(watchmodeCandidates([movie, show], 'US').map(item => item.titleUrl)).toEqual([movie.web_url, show.web_url]);
    expect(watchmodeCandidates([movie], 'CA')).toEqual([]);
    for (const web_url of ['https://tubitv.com/search/men-in-black', 'https://tubitv.com/movies', 'https://tubitv.com/series/123', 'https://tubitv.com/tv-shows/123/episode', 'https://tubitv.com.evil.example/movies/123/title', 'https://user@tubitv.com/movies/123/title']) {
      expect(watchmodeCandidates([{...movie, web_url}], 'US')).toEqual([]);
    }
  });
  it('accepts direct Crunchyroll series links but rejects searches, episodes and spoofed hosts', () => {
    const show = {...row, name:'Crunchyroll', type:'sub', web_url:'https://www.crunchyroll.com/series/GR751KNZY/attack-on-titan'};
    expect(watchmodeCandidates([show], 'US')).toEqual([{sourceId:1, name:'Crunchyroll', region:'US', offerType:'sub', titleUrl:show.web_url, verified:true}]);
    expect(watchmodeCandidates([show], 'GB')).toEqual([]);
    expect(watchmodeCandidates([{...show, name:'Crunchyroll Premium'}], 'US')).toHaveLength(1);
    for (const web_url of ['https://www.crunchyroll.com/search?q=attack', 'https://www.crunchyroll.com/watch/GR751KNZY/attack', 'https://crunchyroll.com.evil.example/series/GR751KNZY/attack', 'https://www.crunchyroll.com/series/GR751KNZY']) {
      expect(watchmodeCandidates([{...show, web_url}], 'US')).toEqual([]);
    }
  });
  it('accepts documented Amazon, Max and Peacock title routes but rejects unsafe variants', () => {
    const prime = {...row, name:'Amazon', web_url:'https://watch.amazon.com/detail?gti=amzn1.dv.gti.c8b498b3-ee7a-5436-4ea9-2b53eaad30ac'};
    const max = {...row, name:'HBO Max', web_url:'https://play.hbomax.com/show/e7dc7b3a-a494-4ef1-8107-f4308aa6bbf7'};
    const peacock = {...row, name:'Peacock', web_url:'https://www.peacocktv.com/watch-online/tv/americas-got-talent/8608728351625543112'};
    expect(watchmodeCandidates([prime, max, peacock], 'US').map(x => x.titleUrl)).toEqual([prime.web_url, max.web_url, peacock.web_url]);
    for (const web_url of ['https://watch.amazon.com/detail', 'https://watch.amazon.com/detail?gti=bad', 'https://watch.amazon.com/detail?gti=amzn1.dv.gti.c8b498b3-ee7a-5436-4ea9-2b53eaad30ac&gti=bad', 'https://watch.amazon.com.evil.example/detail?gti=amzn1.dv.gti.c8b498b3-ee7a-5436-4ea9-2b53eaad30ac']) expect(watchmodeCandidates([{...prime, web_url}], 'US')).toEqual([]);
    expect(watchmodeCandidates([{...max, name:'MAX (Via Amazon Prime)'}], 'US')).toEqual([]);
    expect(watchmodeCandidates([{...peacock, web_url:'https://www.peacocktv.com/watch-online/tv/show/123/seasons/1/episodes/test'}], 'US')).toEqual([]);
  });
  it('accepts Hulu and Disney title pages while rejecting episode and search paths', () => {
    const hulu = {...row, name:'Hulu', web_url:'https://www.hulu.com/series/tell-me-lies-bad099c4-b88d-486a-8e83-b6a5cb1fa6d3'};
    const disney = {...row, name:'Disney+', web_url:'https://www.disneyplus.com/series/black-sands/5qvTiaOfj580'};
    expect(watchmodeCandidates([hulu, disney], 'US').map(x => x.titleUrl)).toEqual([hulu.web_url, disney.web_url]);
    for (const web_url of ['https://www.hulu.com/search?q=show', 'https://www.hulu.com/watch/968f8509-1719-47b2-9b78-29244c9cf079', 'https://www.hulu.com/series/not-a-title', 'https://hulu.com.evil.example/series/bad099c4-b88d-486a-8e83-b6a5cb1fa6d3']) expect(watchmodeCandidates([{...hulu, web_url}], 'US')).toEqual([]);
    expect(watchmodeCandidates([{...disney, web_url:'https://www.disneyplus.com/search?q=black-sands'}], 'US')).toEqual([]);
  });
});
