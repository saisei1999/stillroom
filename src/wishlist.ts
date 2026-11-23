export const WISHLIST_STATUSES = ['Considering', 'Want', 'Purchased', 'Archived'] as const;
export const WISHLIST_PRIORITIES = ['None', 'Low', 'Medium', 'High'] as const;
export const WISHLIST_IMAGE_MAX_BYTES = 1024 * 1024;
export const WISHLIST_MAX_BYTES = 32 * 1024 * 1024;

export type WishlistStatus = typeof WISHLIST_STATUSES[number];
export type WishlistPriority = typeof WISHLIST_PRIORITIES[number];
export type WishlistImage = { kind: 'remote'; url: string } | { kind: 'embedded'; dataUrl: string };
export type WishlistMoney = { amount: string; currency: string };
export type WishlistArrival = { from: string; to?: string };
export type WishlistOfferValues = {
  price?: WishlistMoney;
  shipping?: WishlistMoney;
  arrival?: WishlistArrival;
};
export type WishlistOffer = {
  id: string;
  url: string;
  merchant?: string;
  variant?: string;
  observed?: WishlistOfferValues & { source: string; checkedAt: string };
  overrides?: WishlistOfferValues;
};
export type WishlistRecurrence = {
  unit: 'days' | 'weeks' | 'months';
  interval: number;
  paused: boolean;
  snoozedUntil?: string;
};
export type WishlistPurchase = {
  id: string;
  purchasedOn: string;
  quantity: number;
  paid: WishlistMoney;
};
export type WishlistItem = {
  id: string;
  name: string;
  createdAt: string;
  status: WishlistStatus;
  priority: WishlistPriority;
  notes: string;
  tags: string[];
  groupIds: string[];
  image?: WishlistImage;
  offers: WishlistOffer[];
  primaryOfferId?: string;
  recurrence?: WishlistRecurrence;
  purchases: WishlistPurchase[];
};
export type WishlistGroup = { id: string; name: string };
export type WishlistView = {
  id: string;
  name: string;
  layout: 'gallery' | 'table';
  filters: {
    groupIds?: string[];
    ungrouped?: boolean;
    tags?: string[];
    statuses?: WishlistStatus[];
    priorities?: WishlistPriority[];
  };
  sort: { field: 'name' | 'createdAt' | 'status' | 'priority' | 'price'; direction: 'asc' | 'desc' };
  groupBy: 'none' | 'group' | 'tag' | 'status' | 'priority';
};
export type WishlistData = { items: WishlistItem[]; groups: WishlistGroup[]; views: WishlistView[] };

export function emptyWishlist(): WishlistData {
  return { items: [], groups: [], views: [] };
}

function invalid(field: string): never {
  throw new Error(`Invalid Wishlist ${field}.`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) invalid(field);
  return value;
}

function id(value: unknown): string {
  return string(value, 'ID', 200);
}

function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const match = choices.find((candidate) => candidate === value);
  if (match === undefined) invalid(field);
  return match;
}

function list<T>(value: unknown, field: string, limit: number, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > limit) invalid(field);
  return Array.from(value, parse);
}

function unique<T>(values: T[], key: (value: T) => string, field: string): T[] {
  if (new Set(values.map(key)).size !== values.length) invalid(field);
  return values;
}

function ids(value: unknown): string[] {
  return unique(list(value, 'references', 500, id), (key) => key, 'duplicate references');
}

function tags(value: unknown): string[] {
  return unique(list(value, 'tags', 100, (tag) => string(tag, 'tag', 60)), (tag) => tag, 'duplicate tags');
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid(field);
  return value;
}

function date(value: unknown): string {
  const text = string(value, 'date', 10);
  const time = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== text) invalid('date');
  return text;
}

function timestamp(value: unknown): string {
  const text = string(value, 'timestamp', 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(text)) invalid('timestamp');
  const time = Date.parse(text);
  const canonical = text.length === 20 ? text.replace('Z', '.000Z') : text;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) invalid('timestamp');
  return text;
}

export function parseWishlistWebUrl(value: unknown): URL {
  const text = string(value, 'URL', 4096);
  if (!/^https?:\/\//i.test(text) || /[\s\\]/.test(text)) invalid('URL');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return invalid('URL');
  }
  if (parsed.username || parsed.password) invalid('URL');
  return parsed;
}

function webUrl(value: unknown): string {
  parseWishlistWebUrl(value);
  return value as string;
}

function image(value: unknown): WishlistImage {
  const raw = record(value, 'image');
  if (raw.kind === 'remote') return { kind: 'remote', url: webUrl(raw.url) };
  if (raw.kind !== 'embedded') invalid('image kind');
  const maxEncoded = Math.ceil(WISHLIST_IMAGE_MAX_BYTES / 3) * 4;
  const dataUrl = string(raw.dataUrl, 'image data', maxEncoded + 32);
  const header = /^data:image\/(png|jpeg|gif|webp|avif);base64,/.exec(dataUrl);
  if (!header) invalid('image data');
  const body = dataUrl.slice(header[0].length);
  if (!body.length || body.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) invalid('image data');
  const byteLength = body.length / 4 * 3 - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0);
  if (byteLength > WISHLIST_IMAGE_MAX_BYTES) invalid('image size');
  const prefix = atob(body.slice(0, 24));
  const signatures: Record<string, boolean> = {
    png: prefix.startsWith('\x89PNG\r\n\x1a\n'),
    jpeg: prefix.startsWith('\xff\xd8\xff'),
    gif: prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a'),
    webp: prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP',
    avif: prefix.slice(4, 12) === 'ftypavif' || prefix.slice(4, 12) === 'ftypavis',
  };
  if (!signatures[header[1]]) invalid('image format');
  return { kind: 'embedded', dataUrl };
}

/** Convert a clipboard image to a portable record without keeping an object URL. */
export async function embedWishlistImage(file: Blob): Promise<WishlistImage> {
  if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(file.type)) invalid('image format');
  if (!file.size || file.size > WISHLIST_IMAGE_MAX_BYTES) invalid('image size');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return image({ kind: 'embedded', dataUrl: `data:${file.type};base64,${btoa(binary)}` });
}

function money(value: unknown): WishlistMoney {
  const raw = record(value, 'money');
  const amount = string(raw.amount, 'amount', 25);
  const currency = string(raw.currency, 'currency', 3);
  if (!/^\d{1,18}(\.\d{1,6})?$/.test(amount) || !/^[A-Z]{3}$/.test(currency)) invalid('money');
  return { amount, currency };
}

function arrival(value: unknown): WishlistArrival {
  const raw = record(value, 'arrival');
  const from = date(raw.from);
  if (raw.to === undefined) return { from };
  const to = date(raw.to);
  if (to < from) invalid('arrival window');
  return { from, to };
}

function offerValues(raw: Record<string, unknown>): WishlistOfferValues {
  return {
    ...(raw.price === undefined ? {} : { price: money(raw.price) }),
    ...(raw.shipping === undefined ? {} : { shipping: money(raw.shipping) }),
    ...(raw.arrival === undefined ? {} : { arrival: arrival(raw.arrival) }),
  };
}

function offer(value: unknown): WishlistOffer {
  const raw = record(value, 'offer');
  const result: WishlistOffer = { id: id(raw.id), url: webUrl(raw.url) };
  if (raw.merchant !== undefined) result.merchant = string(raw.merchant, 'merchant', 200);
  if (raw.variant !== undefined) result.variant = string(raw.variant, 'variant', 500);
  if (raw.observed !== undefined) {
    const observed = record(raw.observed, 'observation');
    result.observed = { ...offerValues(observed), source: string(observed.source, 'source', 200), checkedAt: timestamp(observed.checkedAt) };
  }
  if (raw.overrides !== undefined) result.overrides = offerValues(record(raw.overrides, 'overrides'));
  return result;
}

function purchase(value: unknown): WishlistPurchase {
  const raw = record(value, 'purchase');
  return { id: id(raw.id), purchasedOn: date(raw.purchasedOn), quantity: positiveInt(raw.quantity, 'quantity'), paid: money(raw.paid) };
}

function recurrence(value: unknown): WishlistRecurrence {
  const raw = record(value, 'recurrence');
  return {
    unit: choice(raw.unit, ['days', 'weeks', 'months'], 'interval unit'),
    interval: positiveInt(raw.interval, 'interval'),
    paused: bool(raw.paused, 'pause state'),
    ...(raw.snoozedUntil === undefined ? {} : { snoozedUntil: date(raw.snoozedUntil) }),
  };
}

function item(value: unknown): WishlistItem {
  const raw = record(value, 'item');
  const offers = unique(list(raw.offers, 'offers', 200, offer), (entry) => entry.id, 'duplicate offer IDs');
  const result: WishlistItem = {
    id: id(raw.id),
    name: string(raw.name, 'name', 300),
    createdAt: timestamp(raw.createdAt),
    status: choice(raw.status, WISHLIST_STATUSES, 'status'),
    priority: choice(raw.priority, WISHLIST_PRIORITIES, 'priority'),
    notes: string(raw.notes, 'notes', 50_000, true),
    tags: tags(raw.tags),
    groupIds: ids(raw.groupIds),
    offers,
    purchases: unique(list(raw.purchases, 'purchases', 10_000, purchase), (entry) => entry.id, 'duplicate purchase IDs'),
  };
  if (raw.image !== undefined) result.image = image(raw.image);
  if (raw.recurrence !== undefined) result.recurrence = recurrence(raw.recurrence);
  if (raw.primaryOfferId !== undefined) {
    const primary = id(raw.primaryOfferId);
    if (!offers.some((entry) => entry.id === primary)) invalid('primary offer reference');
    result.primaryOfferId = primary;
  } else if (offers.length) {
    invalid('primary offer reference');
  }
  return result;
}

function group(value: unknown): WishlistGroup {
  const raw = record(value, 'group');
  return { id: id(raw.id), name: string(raw.name, 'group name', 120) };
}

function view(value: unknown): WishlistView {
  const raw = record(value, 'view');
  const filters = record(raw.filters, 'filters');
  const sort = record(raw.sort, 'sort');
  return {
    id: id(raw.id),
    name: string(raw.name, 'view name', 120),
    layout: choice(raw.layout, ['gallery', 'table'], 'layout'),
    filters: {
      ...(filters.groupIds === undefined ? {} : { groupIds: ids(filters.groupIds) }),
      ...(filters.ungrouped === undefined ? {} : { ungrouped: bool(filters.ungrouped, 'ungrouped filter') }),
      ...(filters.tags === undefined ? {} : { tags: tags(filters.tags) }),
      ...(filters.statuses === undefined ? {} : { statuses: list(filters.statuses, 'statuses', WISHLIST_STATUSES.length, (status) => choice(status, WISHLIST_STATUSES, 'status')) }),
      ...(filters.priorities === undefined ? {} : { priorities: list(filters.priorities, 'priorities', WISHLIST_PRIORITIES.length, (priority) => choice(priority, WISHLIST_PRIORITIES, 'priority')) }),
    },
    sort: {
      field: choice(sort.field, ['name', 'createdAt', 'status', 'priority', 'price'], 'sort field'),
      direction: choice(sort.direction, ['asc', 'desc'], 'sort direction'),
    },
    groupBy: choice(raw.groupBy, ['none', 'group', 'tag', 'status', 'priority'], 'grouping'),
  };
}

/** Validates references and rebuilds plain records before writing or importing. */
export function parseWishlistData(value: unknown): WishlistData {
  const raw = record(value, 'data');
  const items = unique(list(raw.items, 'items', 10_000, item), (entry) => entry.id, 'duplicate item IDs');
  const groups = unique(list(raw.groups, 'groups', 500, group), (entry) => entry.id, 'duplicate group IDs');
  const views = unique(list(raw.views, 'views', 500, view), (entry) => entry.id, 'duplicate view IDs');
  const groupIds = new Set(groups.map((entry) => entry.id));
  for (const refs of [...items.map((entry) => entry.groupIds), ...views.map((entry) => entry.filters.groupIds ?? [])]) {
    if (refs.some((ref) => !groupIds.has(ref))) invalid('group reference');
  }
  return { items, groups, views };
}
