import { WISHLIST_PRIORITIES, WISHLIST_STATUSES, type WishlistData, type WishlistView } from './wishlist';
import { groupScope, type WishlistArrangement } from './wishlist-view';

type Filters = WishlistView['filters'];

type Option<T> = { value: T; label: string };

export function WishlistChecks<T extends string>({ title, options, selected, onChange }: {
  title: string;
  options: readonly Option<T>[];
  selected: readonly T[];
  onChange: (selected: T[]) => void;
}) {
  if (!options.length) return null;
  return <fieldset className="wishlist-checks">
    <legend>{title}</legend>
    <div>{options.map(({ value, label }) => <label key={value}>
      <input type="checkbox" checked={selected.includes(value)} onChange={(event) => {
        onChange(event.target.checked ? [...selected, value] : selected.filter((key) => key !== value));
      }}/>
      {label}
    </label>)}</div>
  </fieldset>;
}

export function wishlistGroupOptions(groups: WishlistData['groups']) {
  return groups.map((group) => ({ value: group.id, label: group.name }));
}

export function WishlistGroups({ groups, filters, onChange, onAdd, onManage, disabled }: {
  groups: WishlistData['groups'];
  filters: Filters;
  onChange: (filters: Filters) => void;
  onAdd: () => void;
  onManage: (id: string) => void;
  disabled: boolean;
}) {
  const scope = groupScope(filters);
  const currentGroup = groups.find((group) => `group:${group.id}` === scope);
  const options = [
    { key: 'all', label: 'All items', groupIds: [], ungrouped: false },
    { key: 'ungrouped', label: 'Ungrouped', groupIds: [], ungrouped: true },
    ...groups.map((group) => ({ key: `group:${group.id}`, label: group.name, groupIds: [group.id], ungrouped: false })),
  ];
  return <div className="wishlist-groups">
    <div role="group" aria-label="Wishlist groups" className="wishlist-group-list">
      {options.map(({ key, label, groupIds, ungrouped }) => <button key={key} type="button"
        aria-pressed={scope === key} onClick={() => onChange({ ...filters, groupIds, ungrouped })}>{label}</button>)}
    </div>
    <button type="button" disabled={disabled} onClick={onAdd}>+ Group</button>
    {currentGroup && <button type="button" disabled={disabled} onClick={() => onManage(currentGroup.id)}>Edit group</button>}
  </div>;
}

const sortOptions: Option<WishlistView['sort']['field']>[] = [
  { label: 'Date added', value: 'createdAt' },
  { label: 'Name', value: 'name' },
  { label: 'Status', value: 'status' },
  { label: 'Priority', value: 'priority' },
  { label: 'Price', value: 'price' },
];

const groupingOptions: Option<WishlistView['groupBy']>[] = [
  { value: 'none', label: 'None' },
  { value: 'group', label: 'Group' },
  { value: 'tag', label: 'Tag' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
];

export function WishlistControls({ data, view, onChange, viewId, onSelectView, onSave, onManage, busy }: {
  data: WishlistData;
  view: WishlistArrangement;
  onChange: (view: WishlistArrangement) => void;
  viewId: string;
  onSelectView: (id: string) => void;
  onSave: () => void;
  onManage: () => void;
  busy: boolean;
}) {
  const filters = view.filters;
  const tags = [...new Set(data.items.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b));
  const setFilters = (next: Filters) => onChange({ ...view, filters: next });
  const filterCount = (filters.groupIds?.length ?? 0) + Number(Boolean(filters.ungrouped)) +
    (filters.tags?.length ?? 0) + (filters.statuses?.length ?? 0) + (filters.priorities?.length ?? 0);

  return <div className="wishlist-tools">
    <div className="wishlist-toolbar">
      <div className="wishlist-layout" role="group" aria-label="Wishlist layout">
        <button type="button" aria-pressed={view.layout === 'gallery'} onClick={() => onChange({ ...view, layout: 'gallery' })}>Gallery</button>
        <button type="button" aria-pressed={view.layout === 'table'} onClick={() => onChange({ ...view, layout: 'table' })}>Table</button>
      </div>
      <label className="wishlist-tool-select">Saved view<select value={viewId} onChange={(event) => onSelectView(event.target.value)}>
        <option value="">Default view</option>
        {data.views.map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
      </select></label>
      <button type="button" disabled={busy} onClick={onSave}>Save as new view</button>
      {viewId && <button type="button" disabled={busy} onClick={onManage}>Edit saved view</button>}
    </div>
    <div className="wishlist-toolbar">
      <label className="wishlist-tool-select">Sort by<select value={view.sort.field} onChange={(event) => {
        const next = sortOptions.find((option) => option.value === event.target.value);
        if (next) onChange({ ...view, sort: { field: next.value, direction: next.value === 'createdAt' || next.value === 'priority' ? 'desc' : 'asc' } });
      }}>{sortOptions.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button type="button" aria-label={`Sort direction: ${view.sort.direction === 'asc' ? 'ascending' : 'descending'}`}
        title="Reverse sort order" onClick={() => onChange({ ...view, sort: { ...view.sort, direction: view.sort.direction === 'asc' ? 'desc' : 'asc' } })}>
        <span aria-hidden="true">{view.sort.direction === 'asc' ? '↑' : '↓'}</span>
      </button>
      <label className="wishlist-tool-select">Group by<select value={view.groupBy} onChange={(event) => {
        const option = groupingOptions.find(({ value }) => value === event.target.value);
        if (option) onChange({ ...view, groupBy: option.value });
      }}>{groupingOptions.map(({ value, label }) => <option value={value} key={value}>{label}</option>)}</select></label>
      <details className="wishlist-filter">
        <summary>Filters{filterCount ? ` (${filterCount})` : ''}</summary>
        <div className="wishlist-filter-panel">
          <WishlistChecks title="Groups" options={wishlistGroupOptions(data.groups)} selected={filters.groupIds ?? []}
            onChange={(groupIds) => setFilters({ ...filters, groupIds, ungrouped: false })}/>
          <WishlistChecks title="Status" options={WISHLIST_STATUSES.map((value) => ({ value, label: value }))} selected={filters.statuses ?? []}
            onChange={(statuses) => setFilters({ ...filters, statuses })}/>
          <WishlistChecks title="Priority" options={WISHLIST_PRIORITIES.map((value) => ({ value, label: value }))} selected={filters.priorities ?? []}
            onChange={(priorities) => setFilters({ ...filters, priorities })}/>
          <WishlistChecks title="Tags" options={[...new Set([...tags, ...(filters.tags ?? [])])].map((value) => ({ value, label: value }))} selected={filters.tags ?? []}
            onChange={(selectedTags) => setFilters({ ...filters, tags: selectedTags })}/>
          <button type="button" onClick={() => setFilters({})}>Clear filters</button>
        </div>
      </details>
    </div>
  </div>;
}
