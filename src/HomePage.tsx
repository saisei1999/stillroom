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

export function HomePage({ entries, history, displayName, loaded, onAdd, onOpenLibrary, onOpenNotes, onOpenFocus, onOpenEntry, onOpenNote }: HomeProps) {
  const now = new Date();
  const counts = {
    total: entries.length,
    active: entries.filter(entry => entry.status === 'In progress' || entry.status === 'Using').length,
    done: entries.filter(entry => entry.status === 'Completed').length,
  };
  const recent: { entry: Entry; note: { id: string; title: string } }[] = [];
  for (const item of history) {
    if (recent.length === 3) break;
    const entry = entries.find(candidate => candidate.id === item.entryId);
    const note = entry?.noteSections?.find(section => section.id === item.noteId);
    if (entry && note) recent.push({ entry, note });
  }
  const latest = entries.slice(0, 4);
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

    <div className="home-columns">
      <section className="home-block" aria-labelledby="home-continue">
        <div className="home-block-heading"><h2 id="home-continue">Jump back in</h2></div>
        {recent.length > 0
          ? <ul className="home-list">{recent.map(({ entry, note }) =>
              <li key={entry.id + note.id}><button type="button" onClick={() => onOpenNote(entry, note.id)}><span className={`home-dot ${entry.color}`} aria-hidden="true"/><span><strong>{note.title || 'Untitled note'}</strong><small>{entry.title}</small></span></button></li>
            )}</ul>
          : <p className="home-empty">Nothing opened recently. Notes you read will gather here.</p>}
      </section>

      <section className="home-block" aria-labelledby="home-latest">
        <div className="home-block-heading"><h2 id="home-latest">Recently added</h2><button type="button" onClick={onOpenLibrary}>View all</button></div>
        {latest.length > 0
          ? <ul className="home-latest">{latest.map(entry =>
              <li key={entry.id}><button type="button" onClick={() => onOpenEntry(entry)}>
                <span className={`home-thumb ${entry.color}`} style={thumbStyle(entry)} aria-hidden="true">{!entry.artworkUrl && entry.title.slice(0, 1).toUpperCase()}</span>
                <span><strong>{entry.title}</strong><small>{entry.type} · {entry.status}</small></span>
              </button></li>
            )}</ul>
          : <p className="home-empty">{loaded ? 'Your library is quiet. Add the first thing you want to keep.' : 'Opening your library…'}</p>}
      </section>
    </div>
  </section>;
}
