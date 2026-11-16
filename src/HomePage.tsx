import type { CSSProperties } from 'react';
import type { Entry } from './sync-core';
import type { RecentNote } from './recent-notes';

type HomeProps = {
  entries: Entry[];
  history: RecentNote[];
  displayName: string;
  loaded: boolean;
  onAdd: () => void;
  onOpenLibrary: () => void;
  onOpenNotes: () => void;
  onOpenFocus: () => void;
  onOpenEntry: (entry: Entry) => void;
  onOpenNote: (entry: Entry, noteId: string) => void;
  onContextMenu?: (ref: { kind: 'entry' | 'note'; entryId: string; noteId?: string }, x: number, y: number) => void;
};

function greeting(hour: number) {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function thumbStyle(entry: Entry): CSSProperties | undefined {
  return entry.artworkUrl
    ? { backgroundImage: `url("${entry.artworkUrl.replace(/"/g, '%22')}")` }
    : undefined;
}

type RecentNoteCard = { entry: Entry; note: { id: string; title: string; body: string } };

/** First readable line of a note, with block markers stripped. */
export function noteExcerpt(body: string, limit = 140): string {
  const line = body
    .split('\n')
    .map(text => text.replace(/^(#{1,3}\s+|[-*]\s+\[[ x]\]\s+|[-*]\s+|>\s+|\d+\.\s+)/i, '').trim())
    .find(Boolean) ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

export function HomePage({ entries, history, displayName, loaded, onAdd, onOpenLibrary, onOpenNotes, onOpenFocus, onOpenEntry, onOpenNote, onContextMenu }: HomeProps) {
  const now = new Date();
  const counts = {
    total: entries.length,
    active: entries.filter(entry => entry.status === 'In progress' || entry.status === 'Using').length,
    done: entries.filter(entry => entry.status === 'Completed').length,
  };
  const recent: RecentNoteCard[] = [];
  for (const item of history) {
    if (recent.length === 3) break;
    const entry = entries.find(candidate => candidate.id === item.entryId);
    if (!entry) continue;
    const note = item.noteId === 'general'
      ? { id: 'general', title: 'General notes', body: entry.notes }
      : entry.noteSections?.find(section => section.id === item.noteId);
    if (note) recent.push({ entry, note });
  }
  const latest = entries.slice(0, 5);
  const name = displayName.trim();
  const named = name && name !== 'Your profile';

  return <section className="home-page" aria-labelledby="home-title">
    <header className="home-hero">
      <p className="home-date">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <h1 id="home-title">{greeting(now.getHours())}{named ? `, ${name}` : ''}.</h1>
      <p className="home-lede">Your library, your notes, and the things you meant to get back to.</p>
    </header>

    <div className="home-actions" aria-label="Quick actions">
      <button type="button" className="home-action" onClick={onAdd}><span className="home-action-icon" aria-hidden="true">+</span><span><strong>Add an entry</strong><small>Something you want to keep</small></span></button>
      <button type="button" className="home-action" onClick={onOpenLibrary}><span className="home-action-icon" aria-hidden="true">▦</span><span><strong>Browse library</strong><small>Everything you keep</small></span></button>
      <button type="button" className="home-action" onClick={onOpenNotes}><span className="home-action-icon" aria-hidden="true">▤</span><span><strong>Open notes</strong><small>Pick up a thought</small></span></button>
      <button type="button" className="home-action" onClick={onOpenFocus}><span className="home-action-icon" aria-hidden="true">☆</span><span><strong>Focus board</strong><small>What has your attention</small></span></button>
    </div>

    <dl className="home-stats" aria-label="Library at a glance">
      <div><dt>Entries</dt><dd>{loaded ? counts.total : '—'}</dd></div>
      <div><dt>In progress</dt><dd>{loaded ? counts.active : '—'}</dd></div>
      <div><dt>Finished</dt><dd>{loaded ? counts.done : '—'}</dd></div>
    </dl>

    <section className="home-row" aria-labelledby="home-continue">
      <div className="home-row-heading"><h2 id="home-continue">Jump back in</h2><button type="button" onClick={onOpenNotes}>All notes</button></div>
      {recent.length > 0
        ? <ul className="note-row">{recent.map(({ entry, note }) =>
            <li key={entry.id + note.id}><button type="button" className={`note-home ${entry.color}`} onClick={() => onOpenNote(entry, note.id)} onContextMenu={event => { event.preventDefault(); onContextMenu?.({ kind: 'note', entryId: entry.id, noteId: note.id }, event.clientX, event.clientY); }}>
              <span className="note-home-wash" aria-hidden="true"/>
              <span className="note-home-type">{entry.type}</span>
              <strong>{note.title || 'Untitled note'}</strong>
              {noteExcerpt(note.body) && <span className="note-home-excerpt">{noteExcerpt(note.body)}</span>}
              <span className="note-home-foot">{entry.title}</span>
            </button></li>
          )}</ul>
        : <p className="home-empty">Nothing opened recently. Notes you read will gather here.</p>}
    </section>

    <section className="home-row" aria-labelledby="home-latest">
      <div className="home-row-heading"><h2 id="home-latest">Recently added</h2><button type="button" onClick={onOpenLibrary}>View all</button></div>
      {latest.length > 0
        ? <ul className="entry-row">{latest.map(entry =>
            <li key={entry.id}><button type="button" className="entry-home" onClick={() => onOpenEntry(entry)} onContextMenu={event => { event.preventDefault(); onContextMenu?.({ kind: 'entry', entryId: entry.id }, event.clientX, event.clientY); }}>
              <span className={`entry-home-cover ${entry.color}`} style={thumbStyle(entry)} aria-hidden="true">{!entry.artworkUrl && entry.title.slice(0, 1).toUpperCase()}</span>
              <strong>{entry.title}</strong>
              <small>{entry.type} · {entry.status}</small>
            </button></li>
          )}</ul>
        : <p className="home-empty">{loaded ? 'Your library is quiet. Add the first thing you want to keep.' : 'Opening your library…'}</p>}
    </section>
  </section>;
}
