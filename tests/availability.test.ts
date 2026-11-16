import { describe, expect, it } from 'vitest';
import { chooseMatch, confirmedMatch, gameStoreUrl, normalizeTitle, parseChosenMatch, parsePersonalLinks, providerTarget, safeAvailabilityUrl } from '../src/availability';
import { parseEntry } from '../src/sync-core';
import { parseBackup, makeBackup } from '../src/storage';

describe('availability matching', () => {
  it('normalizes punctuation and spacing', () => {
    expect(normalizeTitle('  Fullmetal: Alchemist  ')).toBe('fullmetal alchemist');
  });
  it('automatically selects a single exact match', () => {
    expect(chooseMatch('Naruto', [{ id: '1', title: 'Naruto' }, { id: '2', title: 'Naruto Shippuden' }]).kind).toBe('automatic');
  });
  it('asks for a choice for remakes or approximate results', () => {
    expect(chooseMatch('Dune', [{ id: '1', title: 'Dune', year: 1984 }, { id: '2', title: 'Dune', year: 2021 }]).kind).toBe('choose');
    expect(chooseMatch('Hei', [{ id: '3', title: 'The Legend of Hei' }]).kind).toBe('choose');
  });
  it('retains a confirmed provider identity without relying on search results', () => {
    const match = { id: '37680', title: 'Suits', year: 2011, query: 'Suits', mediaType: 'tv' };
    expect(confirmedMatch(match, 'Suits', 'tv')).toEqual({ id: '37680', title: 'Suits', year: 2011 });
    expect(confirmedMatch(match, 'Suits LA', 'tv')).toBeUndefined();
    expect(confirmedMatch(match, 'Suits', 'movie')).toBeUndefined();
    const entry = { id: 'stable-id', title: 'Suits', type: 'TV / Anime', status: 'Planned', color: 'blue', progress: '', notes: 'keep me', tags: [], createdAt: '2026-01-01', availabilityMatch: match };
    expect(parseEntry(entry)).toMatchObject({ id: 'stable-id', notes: 'keep me', availabilityMatch: match });
    expect(parseBackup(makeBackup([entry]))[0]).toMatchObject({ id: 'stable-id', notes: 'keep me', availabilityMatch: match });
  });
  it('rejects script and credential-bearing links', () => {
    expect(safeAvailabilityUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeAvailabilityUrl('https://user:secret@example.com')).toBeUndefined();
    expect(safeAvailabilityUrl('https://example.com/title')).toBe('https://example.com/title');
  });
  it('only accepts a direct Steam app URL for a confirmed game source', () => {
    expect(gameStoreUrl('Steam','https://store.steampowered.com/app/620')).toBe('https://store.steampowered.com/app/620');
    for (const url of ['https://store.steampowered.com/search/?term=Portal','https://store.steampowered.com/','https://store.steampowered.com.evil.example/app/620','http://store.steampowered.com/app/620']) expect(gameStoreUrl('Steam',url)).toBeUndefined();
    expect(gameStoreUrl('Other','https://store.steampowered.com/app/620')).toBeUndefined();
  });
  it('does not present unverified or search links as provider destinations', () => {
    const own = [{id:'1',label:'Netflix',url:'https://www.netflix.com/title/123'}];
    expect(providerTarget('Netflix','Suits','tv','https://www.themoviedb.org/tv/1/watch',own)).toBeUndefined();
    expect(providerTarget('Netflix','Suits','tv',undefined,[])).toBeUndefined();
    expect(providerTarget('Steam','A','game','https://store.steampowered.com/app/1',[])).toBeUndefined();
  });
  it('preserves personal links in sync parsing and JSON backups', () => {
    const links = [{ id: 'link-1', label: 'Steam', url: 'https://store.steampowered.com/app/1' }];
    const entry = { id: 'entry-1', title: 'Example', type: 'Game', status: 'Planned', color: 'blue', progress: '', notes: '', tags: [], createdAt: '2026-01-01', personalLinks: links };
    expect(parseEntry(entry).personalLinks).toEqual(links);
    expect(parseBackup(makeBackup([entry]))[0].personalLinks).toEqual(links);
    expect(parsePersonalLinks([{ id: 'x', label: 'Bad', url: 'javascript:alert(1)' }])).toBeUndefined();
    const match = { id: '123', title: 'Example', query: 'Example', mediaType: 'game', year: 2020 };
    expect(parseBackup(makeBackup([{...entry, availabilityMatch: match}]))[0].availabilityMatch).toEqual(match);
    expect(parseChosenMatch({...match, id: '123; delete'})).toBeUndefined();
  });
});
