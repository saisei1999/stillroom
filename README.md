# Stillroom (working title)

A local-first, personal media library: cover-forward browsing with quick tracking and portable data. This repository is **prepared for implementation**, not a finished app. The app supports manual entries stored locally in IndexedDB, with status, ratings, tags, notes and progress. Data remains in the same browser and device; browser data clearing or storage eviction can remove it. Export backups regularly.

## Run

Requires Node.js 20+ and npm. Run `npm install`, then `npm run dev`; open the local URL shown. `npm run build` type-checks and builds; `npm test` runs the tests. No provider credentials are required for the preview. GitHub Pages hosts the preview through the deployment workflow after Pages is configured to use GitHub Actions. Fonts are externally hosted and fall back to system fonts offline.

Start with [product](docs/product.md), [design and screens](docs/design.md), [architecture and data](docs/architecture.md), and [milestones](docs/milestones.md). [AGENTS.md](AGENTS.md) is the implementation handoff. The name is provisional. No open-source license has been selected yet.

## Status

Implemented: manual create/edit/delete, local persistence, status, quick rating, tags, text progress, notes, and versioned JSON export/restore. Restore replaces the current library after confirmation. Not implemented: metadata search, cover uploads, numeric progress controls, Markdown export, offline app shell, cross-device sync, collections, statistics, accessibility audit, and end-to-end tests. Storage is tied to the site origin: localhost and GitHub Pages have separate libraries.

