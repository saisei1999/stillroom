import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDatabase, exportLocalBackup, getAccountEntry, listEntries, loadWishlist, makeBackup,
  parseBackup, parseLocalBackup, putEntry, restoreLocalBackup, updateWishlist, type Entry,
} from '../src/storage';
import { embedWishlistImage, emptyWishlist, type WishlistData, type WishlistItem } from '../src/wishlist';

const createdAt = '2026-11-22T10:00:00.000Z';
const media: Entry = {
  id: 'media', title: 'A book', type: 'Book', status: 'In progress', color: 'blue',
  progress: 'Page 10', tags: ['Focus'], rating: 4.3, notes: 'Keep this', createdAt,
  artworkUrl: 'https://example.com/cover.jpg', artworkPosition: 28,
  noteSections: [{ id: 'note', title: 'Chapter one', body: 'A note' }],
};
const legacyProduct: Entry = {
  ...media, id: 'legacy', title: 'Old product', type: 'Product', status: 'Using',
  price: 'about 50 CAD', priority: 'High', productUrl: 'https://example.com/bag?size=large',
};
const item: WishlistItem = {
  id: 'item', name: 'Tea', createdAt, status: 'Purchased', priority: 'High', notes: 'Loose leaf',
  tags: ['pantry'], groupIds: ['essentials', 'birthday'], primaryOfferId: 'shop',
  offers: [{
    id: 'shop', url: 'https://example.com/tea?size=large', merchant: 'Shop', variant: 'Large',
    observed: {
      source: 'merchant', checkedAt: createdAt, price: { amount: '15.25', currency: 'CAD' },
      arrival: { from: '2026-11-25', to: '2026-11-27' },
    },
    overrides: { shipping: { amount: '0', currency: 'CAD' } },
  }],
  recurrence: { interval: 2, unit: 'weeks', paused: false, snoozedUntil: '2026-12-09' },
  purchases: [{ id: 'purchase', quantity: 2, purchasedOn: '2026-11-21', paid: { amount: '21.50', currency: 'CAD' } }],
};
const wishlist: WishlistData = {
  items: [item],
  groups: [{ id: 'essentials', name: 'Essentials' }, { id: 'birthday', name: 'Birthday 2026' }],
  views: [{
    id: 'view', name: 'Shopping', layout: 'table',
    filters: { groupIds: ['essentials'], statuses: ['Purchased'], tags: ['pantry'], priorities: ['High'] },
    sort: { field: 'price', direction: 'asc' }, groupBy: 'status',
  }],
};

function openOldDatabase(version: 1 | 3): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('stillroom-library', version);
    request.onupgradeneeded = () => {
      const db = request.result;
      const entries = db.createObjectStore('entries', { keyPath: 'id' });
      entries.put(media);
      entries.put(legacyProduct);
      if (version === 3) {
        db.createObjectStore('account_entries', { keyPath: ['accountId', 'entryId'] })
          .put({ accountId: 'account', entryId: media.id, entry: media, revision: 7 });
        db.createObjectStore('account_outbox', { keyPath: ['accountId', 'entryId'] });
        db.createObjectStore('account_meta', { keyPath: 'accountId' });
        db.createObjectStore('account_conflicts', { keyPath: ['accountId', 'entryId'] });
        db.createObjectStore('account_backups', { keyPath: ['accountId', 'readyAt'] });
        db.createObjectStore('account_mutations', { keyPath: ['accountId', 'mutationId'] });
        db.createObjectStore('sync_manifest', { keyPath: 'accountId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

beforeEach(() => {
  closeDatabase();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
});

describe('Wishlist persistence and backups', () => {
  it.each([1, 3] as const)('upgrades schema v%s without moving or changing existing records', async (version) => {
    (await openOldDatabase(version)).close();
    expect(await loadWishlist()).toEqual(emptyWishlist());
    expect(await listEntries()).toEqual([legacyProduct, media]);
    if (version === 3) {
      expect(await getAccountEntry('account', media.id)).toEqual({
        accountId: 'account', entryId: media.id, entry: media, revision: 7,
      });
    }
    await expect(openOldDatabase(version)).rejects.toMatchObject({ name: 'VersionError' });
  });

  it('can retry an upgrade once an old tab closes', async () => {
    const oldTab = await openOldDatabase(3);
    try {
      await expect(loadWishlist()).rejects.toThrow('another open tab');
    } finally {
      oldTab.close();
    }
    expect(await loadWishlist()).toEqual(emptyWishlist());
    expect(await listEntries()).toEqual([legacyProduct, media]);
  });

  it('round trips every Wishlist record and pasted image with the media library', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/r1sAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
    const image = await embedWishlistImage(new Blob([bytes], { type: 'image/png' }));
    const data = { ...wishlist, items: [{ ...item, image }] };
    await putEntry(media);
    await putEntry(legacyProduct);
    await updateWishlist(() => data);
    closeDatabase();
    expect(await loadWishlist()).toEqual(data);

    const text = await (await exportLocalBackup()).text();
    expect(JSON.parse(text).version).toBe(3);
    expect(() => parseBackup(text)).toThrow('Unsupported backup');
    closeDatabase();
    globalThis.indexedDB = new IDBFactory();
    await restoreLocalBackup(parseLocalBackup(text));
    expect(await listEntries()).toEqual([legacyProduct, media]);
    expect(await loadWishlist()).toEqual(data);
    expect(image).toEqual({ kind: 'embedded', dataUrl: `data:image/png;base64,${png}` });
  });

  it('round-trips long general and section notes already accepted by the local editor', async () => {
    const entry: Entry = {
      ...media,
      notes: 'n'.repeat(50_001),
      noteSections: [{ id: 'long-note', title: 'Long note', body: 'b'.repeat(50_001) }],
    };
    await putEntry(entry);
    await updateWishlist(() => wishlist);
    const text = await (await exportLocalBackup()).text();
    const malformed = JSON.parse(text);
    malformed.entries[0].noteSections[0].body = 42;
    expect(() => parseLocalBackup(JSON.stringify(malformed))).toThrow('Invalid entry');

    closeDatabase();
    globalThis.indexedDB = new IDBFactory();
    await restoreLocalBackup(parseLocalBackup(text));
    expect(await listEntries()).toEqual([entry]);
    expect(await loadWishlist()).toEqual(wishlist);
  });

  it.each([1, 2])('restores a v%s media backup while keeping current Wishlist records', async (version) => {
    await putEntry(media);
    await updateWishlist(() => wishlist);
    const backup = JSON.stringify({ ...JSON.parse(makeBackup([legacyProduct])), version });
    await restoreLocalBackup(parseLocalBackup(backup));
    expect(await listEntries()).toEqual([legacyProduct]);
    expect(await loadWishlist()).toEqual(wishlist);
  });

  it('round-trips long and numerous media tags without accepting malformed tags', async () => {
    const entry: Entry = { ...media, tags: ['t'.repeat(61), ...Array.from({ length: 100 }, (_, i) => `tag-${i}`)] };
    await putEntry(entry);
    await updateWishlist(() => wishlist);
    const text = await (await exportLocalBackup()).text();
    const malformed = JSON.parse(text);
    malformed.entries[0].tags.push(42);
    expect(() => parseLocalBackup(JSON.stringify(malformed))).toThrow('Invalid entry');

    closeDatabase();
    globalThis.indexedDB = new IDBFactory();
    await restoreLocalBackup(parseLocalBackup(text));
    expect(await listEntries()).toEqual([entry]);
    expect(await loadWishlist()).toEqual(wishlist);
  });

  it('rejects invalid references, unsafe URLs, and malformed purchase dates', async () => {
    const malformed = [
      { ...item, groupIds: ['missing'] },
      { ...item, primaryOfferId: 'missing' },
      { ...item, offers: [{ id: 'shop', url: 'javascript:alert(1)' }] },
      { ...item, purchases: [{ ...item.purchases[0], purchasedOn: '2026-02-30' }] },
      { ...item, image: { kind: 'embedded', dataUrl: 'data:image/png;base64,AAAA' } },
    ];
    await updateWishlist(() => wishlist);
    for (const entry of malformed) {
      const backup = JSON.stringify({ format: 'stillroom', version: 3, entries: [], wishlist: { ...wishlist, items: [entry] } });
      expect(() => parseLocalBackup(backup)).toThrow('Invalid Wishlist');
    }
    await expect(updateWishlist((draft) => ({ ...draft, groups: [] }))).rejects.toThrow('group reference');
    expect(await loadWishlist()).toEqual(wishlist);
  });

  it('serializes concurrent edits against the latest stored collection', async () => {
    await Promise.all([
      updateWishlist((draft) => ({ ...draft, groups: [...draft.groups, wishlist.groups[0]] })),
      updateWishlist((draft) => ({ ...draft, groups: [...draft.groups, wishlist.groups[1]] })),
    ]);
    expect((await loadWishlist()).groups).toEqual(wishlist.groups);
  });

  it('rolls back both domains if storage aborts a combined restore, then permits a retry', async () => {
    await putEntry(media);
    await updateWishlist(() => wishlist);
    const replacement = { entries: [legacyProduct], wishlist: emptyWishlist() };
    const put = IDBObjectStore.prototype.put;
    const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      if (this.name === 'wishlist') {
        request.addEventListener('success', () => this.transaction.abort(), { once: true });
      }
      return request;
    });
    await expect(restoreLocalBackup(replacement)).rejects.toThrow();
    fail.mockRestore();
    expect(await listEntries()).toEqual([media]);
    expect(await loadWishlist()).toEqual(wishlist);

    await restoreLocalBackup(replacement);
    expect(await listEntries()).toEqual([legacyProduct]);
    expect(await loadWishlist()).toEqual(emptyWishlist());
  });
});
