# Design and screens

## Direction
Cover art leads, information stays quiet. Podiums-like visual confidence and Notion-like clarity, with a faint cool-blue console-menu atmosphere. No scanline overlay, pixel fonts, or copied Persona branding. Working title and sample visuals are placeholders.

Canvas #f5f5f1; ink #1f2b3a; navigation #111e2e; accent #7193a3. Use a clean, smooth sans-serif for headings and controls, following the navigation typography. 4/8px spacing rhythm; gallery covers 3:4 with safe fallback; visible focus, 44px touch targets, contrast validated in actual UI. Small transitions around 150–200ms, reduced-motion alternative. Typography must have local/system fallbacks.

## Screen map
1. Collection/home: continue shelf, gallery, search, type/status filters, sort, add; empty and offline states.
2. Add: search results → select title → cover suggestions/upload → confirm status and save; manual entry and unavailable-source states.
3. Item detail: art, editable metadata, status, rating, progress +/- and direct entry, notes, collections, delete with confirmation.
4. Collections: list, create/rename, add/remove items.
5. Insights: counts by status/type and completions; no fabricated statistics.
6. Settings/data: export JSON/Markdown, validated restore with preview, storage availability, provider attribution.

At narrow widths replace sidebar with accessible navigation, use two-column or single-column gallery as space permits, and preserve reachable progress controls. Handle loading, empty, offline, error, quota and missing-art states. Preview is illustrative; review in real browsers and on mobile before approving the design.

## Updated direction from review
The gallery is the first major element: remove oversized hero copy and redundant breadcrumbs/labels. One unified library uses search, tags and sort/filter controls, not media-type tabs. Use the clean DM Sans navigation typography throughout; favor a smooth Apple/PSP-influenced sans-serif feel over editorial serif. Navigation is a collapsible rounded panel, with a profile bubble offering profile and settings. Avoid generic placeholder branding. The profile is envisioned as a personal activity timeline, with contribution-style activity statistics as a later goal; do not imply social networking or sharing is implemented. The current screen is an interactive visual prototype, not a functioning data-backed app.


## Shell refinement
Keep the rounded navigation panel close to the window edge and visually related to the main surface, with a narrow separation. Place a circular profile control at the bottom of the sidebar; its transient menu includes a profile header and access to profile and settings. Keep hover, click, focus, and Escape usable. The references inform spatial organization, not a note-taking app layout.

Keep the working app name in the sidebar header. Remove the redundant main top bar and use a minimal universal image placeholder when artwork is unavailable.
