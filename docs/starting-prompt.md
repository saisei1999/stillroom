You are continuing work on Stillroom, a local-first personal media library, in:
C:\Users\rayfv\Documents\ChatGPT\Stillroom\integration-repository

START BY READING, in this order:
1. AGENTS.md — the safety and release rules for this repo.
2. docs/handoff-2026-11-16.md — current state, uncommitted work, behaviour decisions, traps.
3. docs/architecture.md — UI composition and data model.
4. docs/design.md — visual direction.

Then inspect: `git -c safe.directory=C:/Users/rayfv/Documents/ChatGPT/Stillroom/integration-repository status --short` and `git log --oneline -3`.

CURRENT STATE
- Branch `codex/availability-integration`; HEAD is `f63aeef` plus a docs-only commit. `f63aeef` is also the GitHub `main` tip, so everything after it is local and unpublished.
- Uncommitted and must be preserved: modified `src/main.tsx`, `src/NotesMenu.tsx`, `src/HomePage.tsx`, `src/NotesLibrary.tsx`, `src/AvailabilityPanel.tsx`; new `src/EntryPane.tsx`, `src/SidePanes.tsx`, `src/panes.css`, `tests/side-panes.test.tsx`.
- Untouched by design: `scripts/provider-link-check.ps1`, `supabase/.temp/`.
- Never reset, stash, force-push, clean, or clear browser storage. IndexedDB holds the owner's real library.

WHAT WAS JUST BUILT (already reviewed, do not redo)
Entry page as a full-page canvas: full-bleed artwork with `object-fit: contain` over a blurred copy of the same image, floating `← Library` / `×` / `⋯` controls, star leading the title in one flex row, quiet hairline properties dock absolutely positioned over the hero, autosave with no Save/Saved footer, and a centered opaque notes island whose cards open the existing right-side note editor (no inline expansion). Side panes stack like files and share their width with the main pane.

VERIFY BEFORE YOU CHANGE ANYTHING
    npm test
    node node_modules/typescript/bin/tsc --noEmit
    GITHUB_ACTIONS=true node node_modules/vite/bin/vite.js build --outDir "$TMPDIR/build"
Baseline is 248 passing tests in 27 files, clean tsc, clean build (one pre-existing large-chunk warning).

PREVIEW
A Vite server on http://127.0.0.1:5183/ is serving this checkout and the owner may have annotations open on it. Do not kill it. If a module edit leaves it serving a stale transform (blank `#root`, phantom "does not provide an export named" error), touch the file and reload; if it persists, start a second server on another port with a pty. External image hosts are often blocked here — to judge artwork framing, inject a local canvas data-URI and say in your report that you did.

OPEN QUESTIONS FOR THE OWNER — ask, do not decide alone
1. Mobile Properties: current treatment is a static card under the hero. Do they want a bottom sheet instead?
2. Focal point: only the existing vertical `artworkPosition` is wired; horizontal framing is unimplemented.
3. Platform pills are filtered to verified direct links, which could not be exercised signed-in in this environment.

RULES OF ENGAGEMENT
- Keep scope narrow: change what was asked, report what you left alone.
- Check before publishing, pushing to `main`, deploying, or any destructive change. Publishing is `git push https://github.com/saisei1999/stillroom.git HEAD:main`, which triggers GitHub Pages — only with an explicit yes.
- Report verified observations separately from assumptions: real numbers, real computed styles, real screenshots, real test output. Never claim a visual result from having written the CSS.
- If a requirement collides with the architecture, propose the smallest feasible alternative and ask before changing the approved design.

Begin by reading the four documents and reporting the current git state, then wait for the owner's instruction.
