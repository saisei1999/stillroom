# Wishlist and recurring purchases

Status: owner-confirmed product scope, 2026-11-22. Implementation has not started.
Tracking: [PER-52](https://linear.app/halcyonnetwork/issue/PER-52/wishlist-and-recurring-purchases).
This document is the product source of truth; linked Linear issues track delivery.

## Purpose and boundaries

Give Stillroom a separate Wishlist destination for things the owner may buy, including media, and essentials they purchase repeatedly. Combine Stillroom's artwork-led, quiet light/dark interface and simple tracking with database-like organization. Buying media does not automatically create a media-library entry. Purchased items remain available until explicitly archived or moved.

Keep local-first use available without an account. Preserve the existing library, Notes, Focus, saved views, stable IDs, and backups. Existing legacy Product fields are compatibility inputs, not a complete Wishlist model; define their mapping before migration and preserve original data. Account sync stays disabled under the existing release gates.

## Organization and views

- Cover gallery for browsing and compact table for comparison and editing multiple items.
- Saved views remember filters, sorting, and grouping. Groups are named collections, such as Birthday 2026 and Essentials. One item may belong to several groups; edits update the same record everywhere.
- Tags are independent of groups. Capture from a group assigns that group; capture from All items goes to an Ungrouped inbox.
- Initial properties: name, image, merchant links/offers, groups, tags, priority, status, price, and notes, plus the recurring-purchase controls below.
- Status: Considering, Want, Purchased, Archived. Priority: None, Low, Medium, High; new items start at None.
- Use focused properties initially. Arbitrary user-created database columns are future scope.

## Instant clipboard capture

On Wishlist, Ctrl+V outside a text editor immediately saves compatible content:

- Product URL: create the record first, then fetch title, image, merchant identity/icon, and available price/shipping details in the background.
- Image: create an item using the image; a name and merchant link can be added later.
- Plain text: use the text as the name; add offers later.

Pasting inside editable fields keeps normal editing behavior. Provide Undo for a newly captured item. A URL already saved reveals the existing item instead of creating another, and adds the current group membership where appropriate. Preserve meaningful variant identifiers during duplicate detection. Do not silently merge similar-looking products or different offers.

Lookup failure never blocks capture. Empty, loading, failed, unsupported, and offline enrichment states must remain usable and allow manual editing. Clipboard capture is initiated by paste, not continuous clipboard polling.

## Merchant offers, prices, and shipping

Each item can have several explicitly added merchant links. Choose one primary offer to supply the card's displayed price and merchant icon. Links are clickable and visually tidy, with safe destinations and an icon fallback when unavailable.

An offer describes the linked product/variant. Keep automatically observed values separate from manual overrides; refreshes must preserve manual corrections. Automatic observations include source and last-checked time:

- Price amount and original currency.
- Shipping cost, distinct from item price.
- Estimated arrival date or window, distinct from shipping cost.

Refresh on capture and when opening an item with a stale observation. USD is the default currency, but preserve offer currencies and keep mixed-currency totals separate. Never invent missing prices, treat unknown shipping as free, or imply an arrival date is guaranteed. Initial delivered-cost comparisons exclude tax unless explicitly available and identified.

Country and postal code are optional for shipping estimates. Store them locally; a full address is not required. Disclose when destination information needs to be sent to a lookup service. Missing or unreliable estimates remain Unknown and can be entered manually.

No paid metadata or shopping-search subscriptions initially. Merchant coverage, technical feasibility, source permissions, rate limits, and a free-service approach need investigation before committing to specific automatic coverage. No lookup service or new backend has been approved by this spec.

## Recurring purchases

Any item can have an optional recurrence schedule, independent of its groups, tags, and lifecycle status. Essentials membership alone does not enable recurrence. Support intervals expressed in days, weeks, or months, such as 2 weeks, 30 days, or 3 months.

Record purchase retains an event with the actual purchase date, quantity, amount paid, and currency. History survives later offer refreshes. Calculate the next due date from the actual purchase date and interval.

Upcoming purchases includes active recurring items even when their status is Purchased. Show Due soon, Due today, and Overdue. Allow snoozing and pausing the schedule. Archiving and recurrence need explicit, coherent behavior so an archived item does not accidentally keep prompting.

Version one surfaces reordering inside Stillroom and links to the merchant for a deliberate purchase. Automatic ordering, payments, and external notifications are outside this scope.

## Conceptual records

Use this as modeling guidance, not an approved storage schema:

- Wishlist item: stable identity, editable properties, memberships, offer references, optional recurrence.
- Group and saved view: named organization and remembered presentation, respectively.
- Merchant offer: destination, variant details, observations, overrides, and provenance.
- Purchase event: historical purchase facts, independent of current advertised prices.

Keep storage validation/migrations, URL normalization, enrichment, and date calculations testable independently of React. Version and validate backups for all Wishlist records, including a defined persistence/export strategy for pasted images. Older backups must remain readable without changing the owner's existing media records.

## Acceptance criteria

1. URL, image, and text captures survive reload; normal editor paste is unaffected. Undo and duplicate handling preserve existing items and memberships.
2. The same item appears in multiple groups without duplicating its record. Gallery/table and saved arrangements work on keyboard and touch.
3. Offer selection determines card price/icon. Manual values survive refresh; failed fetching retains the item and known values.
4. Unknown price/shipping/arrival remain explicit; original currencies and observation times are visible.
5. Recording a recurring purchase preserves history and recalculates its next due date. Purchased recurring items remain in Upcoming; snooze and pause work.
6. Backup/restore round trips preserve Wishlist, images under the chosen strategy, and all pre-existing library data. Failed writes remain visible and recoverable.
7. Verify light/dark themes, narrow layouts, focus, reduced motion, and existing entry/note/pane navigation. Required repository checks pass before an approved release.

## Delivery sequence and open implementation decisions

Deliver durable local records and capture first, then organization and item/offer editing, enrichment, recurrence, and a complete interaction/recovery pass. Enrichment feasibility can proceed alongside the local foundation; manual tracking remains useful independently.

| Issue | Delivery slice | Prerequisites |
| --- | --- | --- |
| [PER-64](https://linear.app/halcyonnetwork/issue/PER-64) | Records, migrations and backups | None |
| [PER-65](https://linear.app/halcyonnetwork/issue/PER-65) | Gallery, table, groups and saved views | PER-64 |
| [PER-66](https://linear.app/halcyonnetwork/issue/PER-66) | Instant paste capture | PER-64 |
| [PER-67](https://linear.app/halcyonnetwork/issue/PER-67) | Free enrichment feasibility | None |
| [PER-68](https://linear.app/halcyonnetwork/issue/PER-68) | Item details and merchant offers | PER-64 |
| [PER-69](https://linear.app/halcyonnetwork/issue/PER-69) | Price and shipping refresh | PER-67, PER-68 |
| [PER-70](https://linear.app/halcyonnetwork/issue/PER-70) | Recurrence and purchase history | PER-64 |
| [PER-71](https://linear.app/halcyonnetwork/issue/PER-71) | Interaction and recovery verification | PER-65, PER-66, PER-69, PER-70 |
| [PER-72](https://linear.app/halcyonnetwork/issue/PER-72) | Future best-price discovery | Outside the first release |

These issues belong to milestone **05 · Wishlist and collection expansion** under PER-52.

Resolve and document before implementing the relevant area:

- Representative merchants and tested extraction coverage; permitted fetching architecture, network protections, caching, limits, and destination-data disclosure.
- Staleness interval, observation-failure treatment, and variant/URL canonicalization rules.
- Image persistence/export strategy and non-destructive legacy Product compatibility.
- Undo behavior when edits or asynchronous enrichment race with capture.
- Default initial status, Due soon window, month-end date rules, snooze calculation, and archive/resume semantics.

These are remaining engineering/design decisions, not additional owner-approved features. Ask the owner if resolving one changes the confirmed experience.

## Future candidates

- Best-price discovery across merchants for the exact product and variant, comparing item price plus shipping and identifying unknown costs. Distinguish condition and variant; do not pick a misleading headline price.
- External reorder notifications, continuous price monitoring, and sale alerts.
- Explicit currency conversion and arbitrary custom properties.

Future candidates are not prerequisites for the first usable Wishlist.

