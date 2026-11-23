import { embedWishlistImage, parseWishlistWebUrl, WISHLIST_IMAGE_MAX_BYTES, type WishlistData, type WishlistItem } from './wishlist';

export type CaptureInput =
  | { kind: 'url'; url: URL; html?: string }
  | { kind: 'text'; text: string }
  | { kind: 'image'; file: File };

export type CaptureFields = Pick<WishlistItem, 'name' | 'image' | 'notes' | 'groupIds' | 'tags' | 'status' | 'priority'>;

export function readWishlistClipboard(clipboard: DataTransfer): CaptureInput | undefined {
  const file = Array.from(clipboard.files).find((file) => file.type.startsWith('image/'));
  if (file) return { kind: 'image', file };
  const uris = clipboard.getData('text/uri-list').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const text = uris.length === 1 ? uris[0] : clipboard.getData('text/plain').trim();
  if (!text) return;
  if (/^https?:\/\//i.test(text) && !/\s/.test(text)) {
    return { kind: 'url', url: parseWishlistWebUrl(text), html: clipboard.getData('text/html') };
  }
  return { kind: 'text', text };
}

export async function makeCapturedItem(input: CaptureInput, groupIds: string[], fields?: CaptureFields): Promise<WishlistItem> {
  const item: WishlistItem = {
    name: '', notes: '', groupIds, tags: [], status: 'Considering', priority: 'None', ...fields,
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), offers: [], purchases: [],
  };
  if (input.kind === 'url') {
    const id = crypto.randomUUID();
    item.name ||= input.url.hostname;
    item.primaryOfferId = id;
    item.offers.push({ id, url: input.url.href });
  } else if (input.kind === 'image') {
    if (input.file.size > WISHLIST_IMAGE_MAX_BYTES) throw new Error('Invalid Wishlist image size. Paste an image up to 1 MiB.');
    item.name = 'Pasted image';
    item.image = await embedWishlistImage(input.file);
  } else {
    if (input.text.length > 50_000) throw new Error('Invalid Wishlist text. Paste up to 50,000 characters.');
    item.name = input.text.split(/\r?\n/, 1)[0].slice(0, 300).trim();
    if (item.name !== input.text) item.notes = input.text;
  }
  return item;
}

/** The transaction sees the latest collection and checks every offer on each item. */
export function insertCapturedItem(
  data: WishlistData,
  item: WishlistItem,
  { joinDuplicateGroups = true } = {},
): { id: string; created: boolean; joined: boolean } {
  const url = item.offers[0]?.url;
  const match = url && data.items.find((entry) => entry.offers.some((offer) => new URL(offer.url).href === url));
  if (!match) {
    data.items.push(item);
    return { id: item.id, created: true, joined: false };
  }
  if (!joinDuplicateGroups) return { id: match.id, created: false, joined: false };
  const newGroups = item.groupIds.filter((group) => !match.groupIds.includes(group));
  if (newGroups.length) match.groupIds.push(...newGroups);
  return { id: match.id, created: false, joined: Boolean(newGroups.length) };
}

export function clipboardLinkTitle(input: CaptureInput): string | undefined {
  if (input.kind !== 'url' || !input.html || input.html.length > 100_000) return;
  // Template contents are inert. Only read text from an anchor matching the captured URL.
  const template = document.createElement('template');
  template.innerHTML = input.html;
  const anchors = Array.from(template.content.querySelectorAll('a[href]'));
  if (anchors.length !== 1) return;
  const href = anchors[0].getAttribute('href');
  try {
    if (parseWishlistWebUrl(href).href !== input.url.href) return;
  } catch {
    return;
  }
  const title = anchors[0].textContent?.replace(/\s+/g, ' ').trim();
  if (title && title !== href && title !== input.url.href && title !== input.url.hostname && title.length <= 300) return title;
}

export function sameCapturedItem(item: WishlistItem, snapshot: WishlistItem): boolean {
  return JSON.stringify(item) === JSON.stringify(snapshot);
}

export function applyClipboardTitle(data: WishlistData, snapshot: WishlistItem, title: string): void {
  const item = data.items.find(({ id }) => id === snapshot.id);
  if (item && sameCapturedItem(item, snapshot)) item.name = title;
}

export function undoCapturedItem(data: WishlistData, snapshot: WishlistItem, clipboardTitle?: string): boolean {
  const index = data.items.findIndex(({ id }) => id === snapshot.id);
  if (index < 0) return false;
  const item = data.items[index];
  const enriched = clipboardTitle && { ...snapshot, name: clipboardTitle };
  if (!sameCapturedItem(item, snapshot) && !(enriched && sameCapturedItem(item, enriched))) return false;
  data.items.splice(index, 1);
  return true;
}
