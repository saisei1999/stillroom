# Stillroom (working title)

A local-first, personal media library: cover-forward browsing with quick tracking and portable data. This repository is **prepared for implementation**, not a finished app. The current screen is a static, clearly labeled design preview with sample search, tag and filter controls, and a profile menu; sample entries are not saved.

## Run

Requires Node.js 20+ and npm. Run `npm install`, then `npm run dev`; open the local URL shown. `npm run build` type-checks and builds; `npm test` runs the tests. No provider credentials are required for the preview. GitHub Pages hosts the preview through the deployment workflow after Pages is configured to use GitHub Actions. Fonts are externally hosted and fall back to system fonts offline.

Start with [product](docs/product.md), [design and screens](docs/design.md), [architecture and data](docs/architecture.md), and [milestones](docs/milestones.md). [AGENTS.md](AGENTS.md) is the implementation handoff. The name is provisional. No open-source license has been selected yet.

## Status

Not implemented: persistent library, add/edit, metadata search, artwork, tracking, export/import, offline app shell, collections, statistics, accessibility audit, and end-to-end tests. Do not use this preview to store personal data.


