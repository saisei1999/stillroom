# Stillroom: instructions for coding agents

Stillroom is a personal, local-first media library. Preserve the existing library, Notes, Focus, saved views, progress, ratings, artwork and unrelated changes. Read the relevant code and documentation before changing behavior; `docs/watchmode-release-checklist.md`, `docs/availability.md`, and `docs/platform-links-handoff.md` contain integration and recovery context, but verify dated claims against the current implementation.

## Safety and release

- This repository's GitHub Pages workflow publishes on pushes to `main`. Do not push, merge to `main`, deploy a Supabase function, change production settings, or perform destructive operations without explicit user authorization for that action. The user's current instructions take precedence over stale handoff notes. Never force-push, reset, or discard uncommitted work without authorization.
- Check `git status`, the active branch, and the remote `main` tip before integration. Preserve unrelated files and the original checkout. The historical preservation snapshot is outside the repository under `C:/Users/rayfv/Documents/ChatGPT/Stillroom/g0-preservation-20261115`; do not assume it exists on another machine or commit its contents.
- `npm test` and `npm run build` are the standard checks. Run relevant tests, type checks and responsive/keyboard checks for the change. Verify GitHub Actions and the deployed site after an authorized release. Local preview is commonly `http://127.0.0.1:5182/`, but ports and browser profiles are separate origins with separate local data.

## User data and accounts

- Entries and notes are stored locally in the browser. Preserve IndexedDB and local storage; do not clear site data to fix a problem. JSON restore replaces the local library only after validation and explicit confirmation. Backup format v2 carries fields old clients may not understand; v1 can be read by the current client. Do not downgrade a live frontend after new-format data exists without a tested fail-closed compatibility plan and preserved data.
- Account sign-in is used for live platform lookups. `SYNC_ENABLED` is false: signing in does not move or synchronize local entries. Keep sync disabled until mixed-version clients and data loss risks have been addressed and independently tested. Public signup is deferred at the owner's request; custom SMTP is not configured. Do not enable public signup or modify authentication settings without authorization.
- The profile display name is saved in local storage on the current browser/device, is not an account username, and is not included in library JSON backups or synchronized. An unset name falls back to account metadata or the email's local part, or `Your profile` when signed out. Do not imply that changing it updates the account.

## Availability and direct links

- Show platform icons only for a confirmed media identity and a supported, validated direct title destination in the requested region. Never replace missing title links with platform search pages. If identity or the link is uncertain, hide the icon. Existing entries may lack a saved source match and currently require selecting and saving one; improving automatic matching without silently choosing a wrong remake remains a product priority.
- TMDB provides movie/TV identity and availability; IGDB provides game identity and storefront data; Watchmode provides direct streaming candidates. Watchmode associations are trusted only after region, host and title-route checks, but can still become stale or incorrect. The deployed function verifies signed-in accounts and applies the database quota guard. Preserve the per-account/global limits, cache behavior, keys and server-side secret handling. Never expose or log provider credentials.
- When Watchmode reports a Crunchyroll episode, the approved Wikidata fallback looks up the confirmed TMDB TV ID and requires one matching item and one Crunchyroll series ID. Wikidata establishes identity, not regional availability; a matching Watchmode source is still required. Hide ambiguous/unavailable results. This does not guarantee coverage for all anime or a Netflix result.
- Keep required provider attribution visible on the relevant application screen, while keeping provider credit buttons off individual covers. Settings and the library heading currently link to Watchmode and IGDB; the entry details also credit Watchmode. Check current provider terms before changing attribution placement.

## Engineering and design

- Use strict TypeScript, keep storage, identity and provider logic independent of React when practical, validate untrusted network and import data, and maintain accessible, responsive controls. Add focused tests for data integrity and meaningful behavior. Avoid unrelated dependencies or UI changes.
- The product favors cover-first visual browsing, clean and quiet controls, restrained cool-blue styling, and direct readable platform icons. Prefer a cohesive, simple interface and preserve keyboard focus, contrast and reduced-motion behavior.
