import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SidePanes, type SidePaneRef } from '../src/SidePanes';
import type { Entry } from '../src/sync-core';

const entry: Entry = {
  id: 'e1', title: 'Silksong', type: 'Game', status: 'In progress', color: 'teal', progress: '',
  tags: ['Focus'], rating: 4.5, notes: 'A short general thought.', createdAt: '2026-11-01T00:00:00.000Z',
  noteSections: [{ id: 'n1', title: 'Act II', body: 'The Mantis Lords finally clicked.' }],
};

const refs: SidePaneRef[] = [
  { key: 'e1', kind: 'entry', entryId: 'e1' },
  { key: 'e1:n1', kind: 'note', entryId: 'e1', noteId: 'n1' },
];

const render = (overrides: Partial<React.ComponentProps<typeof SidePanes>> = {}) => renderToStaticMarkup(
  <SidePanes
    panes={refs}
    entries={[entry]}
    front={1}
    onFront={() => {}}
    onClose={() => {}}
    onSave={async () => true}
    onDelete={() => {}}
    onDirty={() => {}}
    dirtyKeys={{}}
    {...overrides}
  />
);

describe('side panes', () => {
  it('renders nothing when empty', () => {
    expect(render({ panes: [] })).toBe('');
  });

  it('renders the real entry editor and reserves peek space', () => {
    const html = render();
    expect(html.match(/is-front/g)?.length).toBe(1);
    expect(html).toContain('--pane-peek:22px');
    expect(html).toContain('entry-pane');
    expect(html).toContain('Entry tracking');
    expect(html).not.toContain('properties-section');
    expect(html).toContain('Act II');
  });

  it('renders the note editor with its body, and handles a missing note', () => {
    expect(render()).toContain('Mantis Lords finally clicked');
    expect(render({ panes: [{ key: 'x', kind: 'note', entryId: 'e1', noteId: 'gone' }], front: 0 }))
      .toContain('no longer in the entry');
  });
  it('keeps many panes selectable without unbounded stack width or hidden editors in the tab order', () => {
    const notes = Array.from({ length: 6 }, (_, index) => ({ id: `n${index}`, title: `Chapter ${index}`, body: 'Retained note text.' }));
    const panes: SidePaneRef[] = notes.map(note => ({ key: note.id, kind: 'note', entryId: entry.id, noteId: note.id }));
    const html = render({ panes, entries: [{ ...entry, noteSections: notes }], front: 0 });
    expect(html).toContain('--pane-peek:66px');
    expect(html.match(/role="tab"/g)).toHaveLength(6);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/inert=""/g)).toHaveLength(5);
    expect(html).toContain('Chapter 5');
  });

  it('does not reserve a tab strip for a single pane', () => {
    const html = render({ panes: [refs[1]], front: 0 });
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-label="Act II"');
    expect(html).toContain('--pane-peek:0px');
  });

});
