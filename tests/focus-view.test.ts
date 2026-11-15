import { describe, expect, it } from 'vitest';
import { isStandardFocusView, type SavedView } from '../src/SavedViews';
const view:SavedView={id:'focus',name:'Focus',tag:'Focus',type:'All types',status:'All statuses',sort:'Recently added'};
describe('Focus navigation',()=>{
 it('recognizes an existing standard Focus view without changing it',()=>{expect(isStandardFocusView(view)).toBe(true);expect(view.id).toBe('focus')});
 it('leaves customized and unrelated views in the custom views list',()=>{expect(isStandardFocusView({...view,status:'Completed'})).toBe(false);expect(isStandardFocusView({...view,tag:'Adventure'})).toBe(false);expect(isStandardFocusView({...view,name:'Favorites'})).toBe(false)});
});

