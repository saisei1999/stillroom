# Product brief

## Promise
Stillroom is a local-first personal home for games, movies, TV/anime, manga, books and music. The library remains usable without an account; a signed-in account is required for platform-link lookups. Account sync is optional and currently disabled in the release candidate.

## Core experience
- Add media manually or select a specific provider result; keep manual entry available when search fails.
- Browse, search, filter and organize a cover-forward library. Track status, progress, notes, tags and an optional rating from 1.0 to 5.0 in 0.1 increments; unrated is distinct from zero.
- Focus contains explicitly focused entries; Notes and existing saved views remain independent navigation tools.
- Show a platform icon only for a supported direct title destination associated with the confirmed media identity. No search or generic provider links as icons. Watchmode is trusted for its title-to-link match after region, domain and route validation; its data may still be stale or wrong.
- Export and restore a versioned JSON backup. Remote artwork is referenced, not bundled; individual Markdown export and richer asset portability remain future work.

## Boundaries
Wishlist is an owner-approved separate domain, specified in [Wishlist and recurring purchases](wishlist.md); it is planned, not implemented. It preserves the existing media library rather than merging the old prototype wholesale. Social feeds, recommendations, native apps, live Obsidian sync and a generic schema builder are out of scope for this milestone. Do not invent metadata or totals.

## Release checks
Validate local data, backups, Notes, Focus and optional sync; test keyboard, touch, narrow screens and reduced motion. Confirm provider rights, attribution and region behavior. Deployment and account-sync activation require separate approval; see `watchmode-release-checklist.md`.
