import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HomePage, noteExcerpt } from '../src/HomePage';
import type { Entry } from '../src/sync-core';

const base: Entry = { id: 'a', title: 'Dune', type: 'Movie', status: 'Completed', color: 'blue', progress: '', tags: [], notes: '', createdAt: '2026-11-01T00:00:00.000Z' };
const entries: Entry[] = [
  { ...base, id: 'b', title: 'Silksong', type: 'Game', status: 'In progress', color: 'teal', noteSections: [{ id: 'n1', title: 'Act II impressions', body: '' }] },
  base,
];

const render = (overrides: Partial<React.ComponentProps<typeof HomePage>> = {}) => renderToStaticMarkup(
  <HomePage entries={entries} history={[{ entryId: 'b', noteId: 'n1' }]} displayName="Bryan" loaded onAdd={() => {}} onOpenLibrary={() => {}} onOpenNotes={() => {}} onOpenFocus={() => {}} onOpenEntry={() => {}} onOpenNote={() => {}} {...overrides} />
);

describe('note excerpt', () => {
  it('strips block markers and clamps long lines', () => {
    expect(noteExcerpt('# A heading\nsecond line')).toBe('A heading');
    expect(noteExcerpt('- [ ] a task')).toBe('a task');
    expect(noteExcerpt('> quoted')).toBe('quoted');
    const long = noteExcerpt('x'.repeat(200));
    expect(long.length).toBe(140);
    expect(long.endsWith('…')).toBe(true);
    expect(noteExcerpt('   ')).toBe('');
  });
});

describe('home page', () => {
  it('counts the real library and lists the latest entries', () => {
    const html = render();
    expect(html).toContain('Entries');
    expect(html).toContain('<dd>2</dd>');
    expect(html).toContain('<dd>1</dd>');
    expect(html).toContain('Silksong');
  });

  it('lists recently opened notes and omits notes it cannot resolve', () => {
    const html = render({ history: [{ entryId: 'b', noteId: 'n1' }, { entryId: 'a', noteId: 'missing' }] });
    expect(html).toContain('Act II impressions');
    expect(html).toContain('Silksong');
    expect(html).not.toContain('Untitled note');
    expect(html.match(/class="note-home /g)?.length).toBe(1);
  });

  it('falls back to quiet empty copy when the library is empty', () => {
    const html = render({ entries: [], history: [], loaded: false });
    expect(html).toContain('Opening your library');
    expect(html).toContain('Nothing opened recently');
  });
});
