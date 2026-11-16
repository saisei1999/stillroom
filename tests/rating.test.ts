import { describe, expect, it } from 'vitest';
import { isValidRating } from '../src/rating';
import { parseEntry } from '../src/sync-core';
import { makeBackup, parseBackup } from '../src/storage';
const entry = {id:'rating-entry',title:'Example',type:'Movie',status:'Planned',color:'blue',progress:'',tags:[],notes:'kept',createdAt:'2026-01-01'};
describe('decimal ratings', () => {
  it('accepts all tenths and rejects invalid values', () => {
    for(let tenths=10;tenths<=50;tenths++) expect(isValidRating(tenths/10)).toBe(true);
    for(const value of [0,0.9,5.1,1.01,NaN,Infinity,'4.2',null]) expect(isValidRating(value)).toBe(false);
  });
  it('preserves decimals, existing whole ratings, and unrated entries through sync and backups', () => {
    for(const rating of [undefined,1,4.2,5]) {
      const original = {...entry,...(rating === undefined ? {} : {rating})};
      expect(parseEntry(original)).toEqual(original);
      expect(parseBackup(makeBackup([original]))).toEqual([original]);
    }
    expect(parseEntry({...entry,rating:null})).toEqual(entry);
    expect(parseBackup(JSON.stringify({format:'stillroom',version:2,entries:[{...entry,rating:null}]}))).toEqual([entry]);
    expect(()=>parseEntry({...entry,rating:4.25})).toThrow();
    expect(()=>parseBackup(makeBackup([{...entry,rating:4.25}]))).toThrow();
  });
});
