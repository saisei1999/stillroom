import {describe,it,expect} from 'vitest';
import {parseLine,serializeLine,moveBlock} from '../src/note-blocks';
describe('note blocks',()=>{
 it('round-trips existing Markdown lines without changing their prefixes',()=>{for(const line of ['# Title','## Detail','12. Twelve','* item','- [x] done','> quote','plain **bold**','','```'])expect(serializeLine(parseLine(line))).toBe(line)});
 it('moves blocks without losing their content',()=>{expect(moveBlock(['one','two','three'],0,2)).toEqual(['two','three','one']);expect(moveBlock(['one'],0,-1)).toEqual(['one'])});
});
