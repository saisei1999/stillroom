import { WISHLIST_PRIORITIES, WISHLIST_STATUSES, type WishlistData, type WishlistItem, type WishlistView } from './wishlist';

export type WishlistArrangement = Omit<WishlistView, 'id' | 'name'>;
export const defaultWishlistArrangement: WishlistArrangement = {
  layout: 'gallery', filters: {}, sort: { field: 'createdAt', direction: 'desc' }, groupBy: 'none',
};

export function primaryPrice(item: WishlistItem) {
  const offer = item.offers.find((entry) => entry.id === item.primaryOfferId);
  return offer?.overrides?.price ?? offer?.observed?.price;
}

function amountKey(amount: string): string {
  const [whole, decimals = ''] = amount.split('.');
  return whole.padStart(18, '0') + decimals.padEnd(6, '0');
}

function compareItems(a: WishlistItem, b: WishlistItem, sort: WishlistView['sort']): number {
  const direction = sort.direction === 'asc' ? 1 : -1;
  switch (sort.field) {
    case 'name': return direction * a.name.localeCompare(b.name, undefined, { numeric: true });
    case 'status': return direction * (WISHLIST_STATUSES.indexOf(a.status) - WISHLIST_STATUSES.indexOf(b.status));
    case 'priority': return direction * (WISHLIST_PRIORITIES.indexOf(a.priority) - WISHLIST_PRIORITIES.indexOf(b.priority));
    case 'price': {
      const one = primaryPrice(a);
      const two = primaryPrice(b);
      if (!one || !two) return Number(Boolean(two)) - Number(Boolean(one));
      return one.currency.localeCompare(two.currency) || direction * amountKey(one.amount).localeCompare(amountKey(two.amount));
    }
    case 'createdAt': return direction * (Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
}

export function visibleWishlistItems(items: WishlistItem[], view: WishlistArrangement): WishlistItem[] {
  const { filters, sort } = view;
  return items.filter((item) => {
    if (filters.ungrouped && item.groupIds.length) return false;
    if (filters.groupIds?.length && !filters.groupIds.some((id) => item.groupIds.includes(id))) return false;
    if (filters.statuses?.length && !filters.statuses.includes(item.status)) return false;
    if (filters.priorities?.length && !filters.priorities.includes(item.priority)) return false;
    return !filters.tags?.length || filters.tags.every((tag) => item.tags.includes(tag));
  }).sort((a, b) => compareItems(a, b, sort) || a.id.localeCompare(b.id));
}

type WishlistSection = { id: string; name?: string; items: WishlistItem[] };

export function wishlistSections(items: WishlistItem[], groups: WishlistData['groups'], view: WishlistArrangement): WishlistSection[] {
  if (view.groupBy === 'none') return [{ id: 'all', items }];
  const sections = new Map<string, WishlistSection>();
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const add = (id: string, name: string, item: WishlistItem) => {
    const section = sections.get(id);
    if (section) section.items.push(item);
    else sections.set(id, { id, name, items: [item] });
  };
  for (const item of items) {
    switch (view.groupBy) {
      case 'group': {
        const selected = view.filters.groupIds;
        const ids = selected?.length ? item.groupIds.filter((id) => selected.includes(id)) : item.groupIds;
        for (const id of ids) add(`group:${id}`, groupNames.get(id) ?? 'Group', item);
        if (!ids.length) add('ungrouped', 'Ungrouped', item);
        break;
      }
      case 'tag':
        for (const tag of item.tags) add(`tag:${tag}`, tag, item);
        if (!item.tags.length) add('untagged', 'Untagged', item);
        break;
      case 'status': add(item.status, item.status, item); break;
      case 'priority': add(item.priority, item.priority, item); break;
    }
  }
  return [...sections.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

export function groupScope(filters: WishlistView['filters']): string | null {
  if (filters.ungrouped) return 'ungrouped';
  if (filters.groupIds?.length === 1) return `group:${filters.groupIds[0]}`;
  return filters.groupIds?.length ? null : 'all';
}
