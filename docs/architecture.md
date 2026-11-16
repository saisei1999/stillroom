# Architecture and data

## Decisions
React, TypeScript and Vite form a browser-first app. IndexedDB is the local source of truth, with explicit migrations and account-partitioned caches and outbox. An account is not required for local library use. The candidate requires sign-in for direct platform-link lookups; sign-in does not itself enable sync or move existing entries. Account sync remains disabled until its independent release gates pass. Browser storage can be cleared or evicted; encourage backups. Offline use after load does not guarantee first load or remote artwork availability.

## Model and portability
Entries retain their app-generated UUID, media type, lifecycle status, notes, progress, tags, optional 1.0–5.0 rating in 0.1 increments, cover URL and optional cover position. An optional confirmed provider match retains the external ID and query; personal links remain durable. Source identity changes must not replace the entry UUID or detach notes.

JSON backups now use version 2 and the new client accepts versions 1 and 2. Version 2 prevents older clients silently dropping new fields. Remote artwork is represented by URL; the current backup does not bundle remote image bytes. Markdown export and richer asset portability are future work. Older clients reject decimal ratings or omit new fields in sync payloads, so do not enable sync until a mixed-version safety strategy is tested.

## Provider strategy
TMDB supplies movie and TV matches; IGDB supplies game matches and some store URLs. Watchmode supplies streaming-link candidates associated with confirmed TMDB IDs. The owner accepts its title association after region, official-domain and title-route checks, with the risk of stale or wrong upstream data. The current candidate supports Netflix and Apple TV streaming pages and Steam game pages; other providers stay hidden. Metadata and link fetching may need internet. Provider secrets remain server-side; provider terms, attribution, caching limits and release checks apply.

Watchmode lookups require a verified account session. Proposed per-account and global rolling credit guards, caching behavior, limitations and rollback are in `watchmode-release-checklist.md`; the updated function and guard have not been deployed. Protect local data and keep account sync optional.
