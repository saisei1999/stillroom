# Product brief

## Promise
A calm, personal home for games, movies, TV/anime, manga, books and music. Search once, choose a cover, save, and update progress in a tap. The library belongs to the user, works without an account and is exportable.

## V1 outcomes
- Add manually or find a title via a supported source; choose among available artwork or upload a cover. Editing and manual fallback always work offline.
- Browse a gallery; search locally, filter by medium and status, and sort by title or updated date.
- Planned, in progress, completed, paused and dropped; optional 0–5 rating (half steps), notes/review, tags and progress with optional total/unit. One-tap increment never silently exceeds a known total.
- Continue shelf, wishlist (planned items), simple user collections, and quiet counts. Editable title and metadata remain user-controlled.
- Versioned complete JSON backup/restore including uploaded image bytes, plus readable Markdown files and image assets for future Obsidian use. Markdown is a one-way export in v1, not live sync.

## Acceptance
An offline user can add, edit, increment and reload an item; errors are visible and never presented as successful saves. A JSON backup restores all user content and uploaded media in a clean browser profile after validation; Markdown export retains notes and points to included assets. Search failures and missing artwork have graceful manual fallbacks. Keyboard and narrow-screen core flows are usable.

## Out of scope
Accounts, social feeds, recommendations, ranking algorithms, automatic cross-device sync, native apps, automatic vault sync, and a full Notion-style formula database. No invented totals or metadata.

## Profile direction
A local personal profile should eventually present a chronological activity timeline (such as progress, reviews, and milestones). A contribution-style activity visualization is a later goal. This is a personal history, not a commitment to accounts, public feeds, or social sharing. Scope its persistence, privacy and backup format before implementation.
