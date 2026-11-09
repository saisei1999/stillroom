# Milestones and executable handoff

## 0. Foundation (current)
- [x] Product, design, architecture and task briefs.
- [x] React/TypeScript design preview scaffold.
- [x] Install dependencies, generate lockfile, run build and test harness. The repository is initialized but has no initial commit.

## 1. Data integrity vertical slice
- [ ] Define and validate schema, IndexedDB transactions and migrations; surface failure and quota errors.
- [ ] Manual add/edit, status, progress, rating, notes, delete confirmation, gallery, local filtering and continue shelf.
- [ ] Test add/edit/reload and increment boundaries, failed writes, migrations, empty state and keyboard flow.

## 2. Ownership
- [ ] Complete JSON backup/validated restore with assets, merge/replace rules and round-trip tests; Markdown bundle with safe filenames and manifest.
- [ ] Offline app shell and persistent-storage request with honest availability messaging. Test offline reload after initial installation and full restore in a clean profile.

## 3. Discovery
- [ ] Document source-specific terms, credentials, attribution, image usage and CORS before enabling each adapter. Implement one low-friction source at a time with multiple available covers, upload, cancellation and fallback.
- [ ] Contract tests with fixtures; network failures, rate limits, duplicates and missing artwork. No secrets in client.

## 4. Polish and release
- [ ] Collections, quiet derived stats, responsive and keyboard audits, reduced motion, data recovery and export usability.
- [ ] End-to-end tests for core flow; visual QA across desktop/mobile; document setup, licensing, limitations, release checklist and backup practice.

Definition of done: no silent data loss, build and tests pass, core flows usable offline after first load, documented limitations accurate, and representative keyboard/mobile checks completed.


## Future profile milestone
- [ ] Design a local profile and personal activity timeline; define what events are recorded, edited, deleted and included in exports.
- [ ] Explore a contribution-style activity view after reliable event history exists; avoid implying public feeds or social accounts.
