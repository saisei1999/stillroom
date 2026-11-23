import { describe, expect, it } from 'vitest';
import type { WishlistItem } from '../src/wishlist';
import { defaultWishlistArrangement, groupScope, visibleWishlistItems, wishlistSections, type WishlistArrangement } from '../src/wishlist-view';

function item(id: string, patch: Partial<WishlistItem> = {}): WishlistItem {
  return {
    id, name: id, createdAt: '2026-11-22T10:00:00.000Z', status: 'Considering', priority: 'None',
    notes: '', tags: [], groupIds: [], offers: [], purchases: [], ...patch,
  };
}

describe('Wishlist arrangements', () => {
  it('combines group, tag, status and priority filters without duplicating items', () => {
    const items = [
      item('Tea', { groupIds: ['gifts', 'essentials'], tags: ['pantry', 'annual'], status: 'Want', priority: 'High' }),
      item('Coffee', { groupIds: ['essentials'], tags: ['pantry'], status: 'Purchased', priority: 'High' }),
      item('Rice', { tags: ['pantry'], status: 'Want', priority: 'High' }),
      item('Olive oil', { groupIds: ['essentials'], tags: ['pantry', 'annual'], status: 'Want', priority: 'Low' }),
    ];
    const view: WishlistArrangement = {
      ...defaultWishlistArrangement,
      filters: { groupIds: ['gifts', 'essentials'], tags: ['pantry', 'annual'], statuses: ['Want'], priorities: ['High'] },
    };
    expect(visibleWishlistItems(items, view)).toEqual([items[0]]);
    expect(visibleWishlistItems(items, { ...defaultWishlistArrangement, filters: { ungrouped: true } })).toEqual([items[2]]);
  });

  it('renders one shared record in multiple group sections and respects a scoped group filter', () => {
    const tea = item('Tea', { groupIds: ['essentials', 'ungrouped'] });
    const groups = [{ id: 'essentials', name: 'Essentials' }, { id: 'ungrouped', name: 'Gifts' }];
    const view = { ...defaultWishlistArrangement, groupBy: 'group' as const };
    const sections = wishlistSections([tea], groups, view);
    expect(sections.map((part) => part.name)).toEqual(['Essentials', 'Gifts']);
    expect(sections[0].items[0]).toBe(sections[1].items[0]);
    expect(groupScope({ groupIds: ['ungrouped'] })).toBe('group:ungrouped');
    expect(wishlistSections([tea], groups, { ...view, filters: { groupIds: ['essentials'] } }))
      .toEqual([{ id: 'group:essentials', name: 'Essentials', items: [tea] }]);
  });

  it('uses the primary offer override, groups prices by currency and places unknown values last', () => {
    const priced = (id: string, currency: string, amount: string) => item(id, {
      primaryOfferId: 'shop',
      offers: [
        { id: 'other', url: 'https://example.com/other', overrides: { price: { amount: '1', currency } } },
        { id: 'shop', url: 'https://example.com/shop', overrides: { price: { amount, currency } },
          observed: { source: 'shop', checkedAt: '2026-11-22T10:00:00.000Z', price: { amount: '2', currency } } },
      ],
    });
    const items = [item('Unknown'), priced('USD item', 'USD', '1'), priced('CAD lower', 'CAD', '9.75'), priced('CAD higher', 'CAD', '10')];
    expect(visibleWishlistItems(items, { ...defaultWishlistArrangement, sort: { field: 'price', direction: 'desc' } }).map(({ id }) => id))
      .toEqual(['CAD higher', 'CAD lower', 'USD item', 'Unknown']);
  });
});
