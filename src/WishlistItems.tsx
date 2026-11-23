import { useId, useState, type FormEventHandler } from 'react';
import { WishlistChecks, wishlistGroupOptions } from './WishlistControls';
import { parseWishlistWebUrl, WISHLIST_PRIORITIES, WISHLIST_STATUSES, type WishlistData, type WishlistItem } from './wishlist';
import { primaryPrice } from './wishlist-view';

type ItemEdit = Pick<WishlistItem, 'name' | 'status' | 'priority' | 'tags' | 'groupIds' | 'notes' | 'image'>;
export type WishlistItemPatch = Partial<ItemEdit>;

export function WishlistBag({ size = 24 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 8h14l1 12H4L5 8Zm4 1V7a3 3 0 0 1 6 0v2"/>
  </svg>;
}

function Cover({ item }: { item: WishlistItem }) {
  const src = item.image?.kind === 'remote' ? item.image.url : item.image?.dataUrl;
  const [failed, setFailed] = useState<string>();
  return <span className="wishlist-cover">
    <WishlistBag size={40}/>
    {src && src !== failed && <img alt="" src={src} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)}/>}
  </span>;
}

function priceText(item: WishlistItem) {
  const price = primaryPrice(item);
  return price ? `${price.currency} ${price.amount}` : 'Unknown';
}

function Price({ item }: { item: WishlistItem }) {
  return <span className="wishlist-price">{priceText(item)}</span>;
}

export function WishlistGallery({ items, groups, onEdit }: {
  items: WishlistItem[];
  groups: WishlistData['groups'];
  onEdit: (item: WishlistItem) => void;
}) {
  const galleryId = useId();
  const names = new Map(groups.map((group) => [group.id, group.name]));
  return <ul className="wishlist-gallery">{items.map((item, index) => <li key={item.id}>
    <button className="wishlist-card" type="button" data-wishlist-item={item.id}
      aria-label={`Edit ${item.name}`} aria-describedby={`${galleryId}-details-${index}`} onClick={() => onEdit(item)}>
      <Cover item={item}/>
      <span className="wishlist-card-content">
        <span className="wishlist-card-heading"><strong>{item.name}</strong><Price item={item}/></span>
        <span className="wishlist-card-meta">
          <span className="wishlist-status" data-status={item.status}>{item.status}</span>
          {item.priority !== 'None' && <span>{item.priority} priority</span>}
        </span>
        {(item.groupIds.length > 0 || item.tags.length > 0) && <span className="wishlist-card-labels">
          {item.groupIds.map((id) => <span key={`group:${id}`}>{names.get(id)}</span>)}
          {item.tags.map((tag) => <span className="wishlist-tag" key={`tag:${tag}`}>#{tag}</span>)}
        </span>}
      </span>
    </button>
    <span id={`${galleryId}-details-${index}`} hidden>
      {`Price ${priceText(item)}. Status ${item.status}. Priority ${item.priority}.`}
      {item.groupIds.length > 0 && ` Groups ${item.groupIds.map((id) => names.get(id)).join(', ')}.`}
      {item.tags.length > 0 && ` Tags ${item.tags.join(', ')}.`}
    </span>
  </li>)}</ul>;
}

export function WishlistTable({ items, groups, label, busy, onEdit, onUpdate }: {
  items: WishlistItem[];
  groups: WishlistData['groups'];
  label: string;
  busy: boolean;
  onEdit: (item: WishlistItem) => void;
  onUpdate: (id: string, patch: WishlistItemPatch) => void;
}) {
  const names = new Map(groups.map((group) => [group.id, group.name]));
  return <div className="wishlist-table-scroll" tabIndex={0} role="region" aria-label={`${label} table`}>
    <table aria-label={label} className="wishlist-table">
      <thead><tr>{['Item', 'Status', 'Priority', 'Groups', 'Tags', 'Price'].map((name) => <th key={name} scope="col">{name}</th>)}</tr></thead>
      <tbody>{items.map((item) => <tr key={item.id}>
        <th scope="row"><button type="button" data-wishlist-item={item.id} aria-label={`Edit ${item.name}`} onClick={() => onEdit(item)}>
          <Cover item={item}/><span>{item.name}</span>
        </button></th>
        <td><select aria-label={`Status for ${item.name}`} value={item.status} aria-disabled={busy} onChange={(event) => {
          const status = WISHLIST_STATUSES.find((status) => status === event.target.value);
          if (status && !busy) onUpdate(item.id, { status });
        }}>{WISHLIST_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></td>
        <td><select aria-label={`Priority for ${item.name}`} value={item.priority} aria-disabled={busy} onChange={(event) => {
          const priority = WISHLIST_PRIORITIES.find((priority) => priority === event.target.value);
          if (priority && !busy) onUpdate(item.id, { priority });
        }}>{WISHLIST_PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select></td>
        <td>{item.groupIds.map((id) => names.get(id)).join(', ') || 'Ungrouped'}</td>
        <td>{item.tags.join(', ') || '—'}</td>
        <td><Price item={item}/></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function WishlistItemForm({ item, initialGroups, groups, busy, onSubmit, onCancel }: {
  item?: WishlistItem;
  initialGroups: string[];
  groups: WishlistData['groups'];
  busy: boolean;
  onSubmit: (values: ItemEdit, productLink?: URL) => void;
  onCancel: () => void;
}) {
  const [tags, setTags] = useState(item?.tags ?? []);
  const [tag, setTag] = useState('');
  const [groupIds, setGroupIds] = useState(item?.groupIds ?? initialGroups);
  const [removeEmbedded, setRemoveEmbedded] = useState(false);
  const [error, setError] = useState('');
  const primaryOffer = item?.offers.find((offer) => offer.id === item.primaryOfferId);
  function nextTags() {
    const name = tag.trim();
    if (!name || tags.includes(name)) return tags;
    if (tags.length === 100) {
      setError('An item can have up to 100 tags.');
      return;
    }
    return [...tags, name];
  }
  function addTag() {
    const next = nextTags();
    if (!next) return;
    setTags(next);
    setTag('');
    setError('');
  }
  const submit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    const status = WISHLIST_STATUSES.find((value) => value === data.get('status'));
    const priority = WISHLIST_PRIORITIES.find((value) => value === data.get('priority'));
    const url = String(data.get('image') ?? '').trim();
    const allTags = nextTags();
    const linkText = String(data.get('productLink') ?? '').trim();
    let productLink: URL | undefined;
    if (linkText) {
      try {
        productLink = parseWishlistWebUrl(linkText);
      } catch {
        setError('Enter a valid product link starting with https:// or http://.');
        return;
      }
    }
    if (!name && !productLink) {
      setError('Enter a product link or an item name.');
      return;
    }
    if (!status || !priority || !allTags) return;
    onSubmit({
      name, status, priority, groupIds, tags: allTags,
      notes: String(data.get('notes') ?? ''),
      image: url ? { kind: 'remote', url } : item?.image?.kind === 'embedded' && !removeEmbedded ? item.image : undefined,
    }, productLink);
  };

  return <form className="wishlist-form" onSubmit={submit}>
    {!item && <label>Product link<input name="productLink" type="url" inputMode="url" maxLength={4096} placeholder="https://"/></label>}
    {primaryOffer && <a className="wishlist-product-link" href={primaryOffer.url} target="_blank" rel="noreferrer">Open product page ↗</a>}
    <label>Name<input name="name" required={Boolean(item)} maxLength={300} defaultValue={item?.name}/></label>
    <div className="wishlist-form-row">
      <label>Status<select name="status" aria-label="Status" defaultValue={item?.status ?? 'Considering'}>{WISHLIST_STATUSES.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Priority<select name="priority" aria-label="Priority" defaultValue={item?.priority ?? 'None'}>{WISHLIST_PRIORITIES.map((value) => <option key={value}>{value}</option>)}</select></label>
    </div>
    <WishlistChecks title="Groups" options={wishlistGroupOptions(groups)} selected={groupIds} onChange={setGroupIds}/>
    <fieldset className="wishlist-item-tags">
      <legend>Tags</legend>
      {tags.length > 0 && <ul>{tags.map((value) => <li key={value}>
        <button type="button" aria-label={`Remove tag ${value}`} onClick={() => setTags((values) => values.filter((tag) => tag !== value))}>{value} ×</button>
      </li>)}</ul>}
      <div className="wishlist-tag-input">
        <input aria-label="New tag" maxLength={60} value={tag} onChange={(event) => setTag(event.target.value)} onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          addTag();
        }}/>
        <button type="button" onClick={addTag} disabled={!tag.trim()}>Add tag</button>
      </div>
    </fieldset>
    <label>Image URL (optional)<input name="image" type="url" inputMode="url" maxLength={4096}
      defaultValue={item?.image?.kind === 'remote' ? item.image.url : ''}/></label>
    {item?.image?.kind === 'embedded' && <label className="wishlist-inline-check"><input type="checkbox" checked={removeEmbedded}
      onChange={(event) => setRemoveEmbedded(event.target.checked)}/> Remove embedded image</label>}
    <label>Notes<textarea name="notes" rows={3} maxLength={50_000} defaultValue={item?.notes}/></label>
    {error && <p role="alert" className="wishlist-error">{error}</p>}
    <div className="wishlist-dialog-actions">
      <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" className="wishlist-primary" disabled={busy}>{item ? 'Save changes' : 'Add item'}</button>
    </div>
  </form>;
}
