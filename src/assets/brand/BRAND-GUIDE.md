# Stillroom — Geometric Stillpoint mark · v0.1

## Design intent

An open rounded diamond suggests a room or collection; the inward glint captures one personally meaningful experience. The deliberate right-hand opening suggests an ongoing relationship with media. This preserves the existing Stillroom diamond language without an obvious movie/play/audio symbol.

## Files

- `mark.svg`: normal icon, transparent background, 100-unit viewBox.
- `mark-small.svg`: optically simplified compact icon for 16–24px display.
- `app-icon.svg`: standalone dark 256-unit square app mark.
- `lockup-dark.svg`, `lockup-light.svg`: horizontal wordmark lockups.

## Tokens

| Token | Color | Role |
|---|---|---|
| Deep navy | `#15242D` | Primary background, light-theme mark |
| Icy blue | `#88C6E7` | Dark-theme mark, interactive emphasis |
| Near-white | `#F7F9F6` | Light surfaces, dark-theme wordmark |

## Geometry

- One continuous rounded-diamond stroke; right-side gap between its upper/lower terminals.
- Outer mark has 7/100 stroke width, round caps and joins.
- Central glint reduced relative to early concepts and kept clear of the orbit.
- Compact version reduces the central glint and uses a thicker relative stroke for 16px.

## Implementation and validation

Use `mark-small.svg` for 16px sidebar icon and `mark.svg` at >=24px. Keep clear space of at least 1/4 mark width around standalone icons. Use the navy app tile as supplied or adapt its corner radius to platform requirements. Do not distort the symbol or add shadows/gradients.

The wordmark is still **typeset text**, not custom outlined lettering. Font rendering will vary by device. Before a final trademark/brand release, choose and license a specific font and convert the approved lockup to outlines. This is a production-ready *candidate vector kit*, not a claim of trademark clearance or final optical signoff.

## Codex integration

Add assets on an isolated feature branch. Do not change the existing Stillroom navigation structure. Replace only the brand mark and wordmark, verify at 16/24/48/256px, light/dark contrast, high-DPI and favicon, and compare screenshots. Do not push/deploy until reviewed.
