import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, loadWishlist, updateWishlist } from '../src/storage';
import { applyClipboardTitle, insertCapturedItem, makeCapturedItem, readWishlistClipboard, undoCapturedItem } from '../src/wishlist-capture';
import { parseWishlistWebUrl } from '../src/wishlist';

function product(url: string, groups: string[] = []) {
  return makeCapturedItem({ kind: 'url', url: parseWishlistWebUrl(url) }, groups);
}

beforeEach(() => {
  closeDatabase();
  globalThis.indexedDB = new IDBFactory();
});

describe('Wishlist capture', () => {
  it('prefers a single clipboard link over display text and rejects credentials', () => {
    const clipboard = (uri: string, text: string) => ({
      files: [], getData: (type: string) => type === 'text/uri-list' ? uri : type === 'text/plain' ? text : '',
    }) as unknown as DataTransfer;
    expect(readWishlistClipboard(clipboard('# Link\r\nhttps://merchant.example/p#red', 'Red mug')))
      .toMatchObject({ kind: 'url', url: new URL('https://merchant.example/p#red') });
    expect(readWishlistClipboard(clipboard('', 'two lines\nhttps://merchant.example/p')))
      .toEqual({ kind: 'text', text: 'two lines\nhttps://merchant.example/p' });
    expect(() => readWishlistClipboard(clipboard('', 'https://someone:secret@merchant.example/'))).toThrow('Invalid Wishlist URL');
  });

  it('deduplicates concurrent capture and preserves variants, existing fields and group memberships', async () => {
    await updateWishlist((draft) => {
      draft.groups.push({ id: 'one', name: 'One' }, { id: 'two', name: 'Two' });
      return draft;
    });
    const first = await product('https://MERCHANT.example:443/p?size=s#blue', ['one']);
    first.name = 'Blue mug';
    const duplicate = await product('https://merchant.example/p?size=s#blue', ['two']);
    const other = await product('https://merchant.example/p?size=m#blue');
    const save = (item: typeof first) => updateWishlist((draft) => {
      insertCapturedItem(draft, item);
      return draft;
    });
    await Promise.all([save(first), save(duplicate), save(other)]);
    closeDatabase();
    const { items } = await loadWishlist();
    expect(items.map((item) => item.id)).toEqual([first.id, other.id]);
    expect(items[0]).toMatchObject({ name: 'Blue mug', groupIds: ['one', 'two'], status: 'Considering', priority: 'None' });
    expect(items[0].offers[0].url).toBe('https://merchant.example/p?size=s#blue');
  });

  it('does not overwrite edits or undo a capture after an item has changed', async () => {
    const item = await product('https://merchant.example/p');
    const { items: [snapshot] } = await updateWishlist((draft) => {
      insertCapturedItem(draft, item);
      return draft;
    });
    const next = await updateWishlist((draft) => {
      draft.items[0].name = 'My title';
      applyClipboardTitle(draft, snapshot, 'Clipboard title');
      expect(undoCapturedItem(draft, snapshot, 'Clipboard title')).toBe(false);
      return draft;
    });
    expect(next.items[0].name).toBe('My title');
  });

  it('finds a manual duplicate without applying any draft fields or memberships', async () => {
    const saved = await product('https://merchant.example/p');
    const manual = { ...await product('https://merchant.example/p', ['new-group']), name: 'Draft', notes: 'Keep typing' };
    await updateWishlist((data) => {
      data.groups.push({ id: 'new-group', name: 'New group' });
      insertCapturedItem(data, saved);
      return data;
    });
    const next = await updateWishlist((data) => {
      expect(insertCapturedItem(data, manual, { joinDuplicateGroups: false }))
        .toEqual({ id: saved.id, created: false, joined: false });
      return data;
    });
    expect(next.items).toEqual([saved]);
  });

  it('undoes a locally enriched capture and ignores a late title for a removed item', async () => {
    const item = await product('https://merchant.example/p');
    const { items: [snapshot] } = await updateWishlist((draft) => {
      insertCapturedItem(draft, item);
      return draft;
    });
    const next = await updateWishlist((draft) => {
      applyClipboardTitle(draft, snapshot, 'Clipboard title');
      expect(draft.items[0].name).toBe('Clipboard title');
      expect(undoCapturedItem(draft, snapshot, 'Clipboard title')).toBe(true);
      applyClipboardTitle(draft, snapshot, 'Clipboard title');
      return draft;
    });
    expect(next.items).toEqual([]);
  });

  it('retains long pasted text in notes and keeps pasted images separate from merchant links', async () => {
    const text = 'Item title\n' + 'detail '.repeat(100);
    const note = await makeCapturedItem({ kind: 'text', text }, []);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/r1sAAAAASUVORK5CYII=';
    const file = new File([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], 'item.png', { type: 'image/png' });
    const image = await makeCapturedItem({ kind: 'image', file }, []);
    await updateWishlist((draft) => {
      insertCapturedItem(draft, note);
      insertCapturedItem(draft, image);
      return draft;
    });
    closeDatabase();
    const { items } = await loadWishlist();
    expect(items[0]).toMatchObject({ name: 'Item title', notes: text, offers: [] });
    expect(items[1]).toMatchObject({ image: { kind: 'embedded', dataUrl: `data:image/png;base64,${png}` }, offers: [] });
  });
});
