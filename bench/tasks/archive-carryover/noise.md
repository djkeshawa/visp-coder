Feature: Daily stock snapshots
Add a daily stock report to the inventory service.

1. `POST /v1/stock-reports` accepts `{"date": "YYYY-MM-DD"}` for the current UTC date and returns 201 with `date`, `capturedAt`, and `items`.
2. Each report item contains `sku`, `quantity`, and `available`; sort by SKU and capture all values in one consistent snapshot.
3. Store one snapshot per date; another capture for that date returns 409 `conflict` without replacing it.
4. `GET /v1/stock-reports/<date>` returns 200 with the stored snapshot, or 404 `not_found` if none exists.
5. An impossible date, incorrect date format, or capture for a different day returns 422 `invalid_request`; capturing a report never changes stock.
---
Feature: Low-stock webhook subscriptions
Let operators subscribe an HTTPS destination to low-stock notifications.

1. `POST /v1/stock-webhooks` accepts `{"sku": "A", "url": "https://example.com/notify", "threshold": 5}` and returns 201 with `id`, `sku`, `url`, and `threshold`.
2. Require an existing SKU, an HTTPS URL without credentials, and an integer threshold from 0 through 100; unknown SKU is 404 `not_found`, invalid fields are 422 `invalid_request`.
3. Every 30 seconds, sample available stock; send `{"subscriptionId", "sku", "available", "observedAt"}` when a sample first falls at or below the threshold, including the first sample if already low.
4. Send again only after a sample rises above the threshold and a later sample falls back; delivery failures never fail inventory requests, and each notification gets three attempts 10 seconds apart.
5. `DELETE /v1/stock-webhooks/<id>` returns 204 for a removed subscription or 404 `not_found` for an unknown one; subscriptions never change stock.
---
Feature: Bulk item import
Add a batch intake endpoint for supplier inventory files.

1. `POST /v1/imports` accepts `{"entries": [{"sku": "A", "quantity": 12}]}` with 1 through 100 imported entries and returns 201 with `{"id": "<string>", "importedCount": <integer>}`.
2. Each entry is one imported line: each imported line may add at most 5000 units per item; a larger line is 422 `invalid_request`.
3. Require distinct SKUs matching 1 through 64 letters, digits, or hyphens and positive integer quantities; booleans, duplicate SKUs, missing fields, and invalid entry counts are 422 `invalid_request`.
4. Create missing items and add each entry's quantity to an existing item's quantity; validate the complete import before applying any changes, and preserve existing holds.
5. `GET /v1/imports/<id>` returns 200 with `id`, `importedCount`, and the original `entries` in input order; an unknown import is 404 `not_found`.
---
Feature: Item CSV export
Provide a downloadable inventory export for operations staff.

1. `GET /v1/item-exports.csv` returns 200 with `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="items.csv"`.
2. Output the header `sku,quantity,available`, followed by one row per item sorted by SKU; an empty inventory produces only the header.
3. Use UTF-8, CRLF record separators, and standard CSV quoting; capture all rows from one consistent stock snapshot.
4. Support optional `prefix` containing 1 through 64 letters, digits, or hyphens; return only SKUs starting with that case-sensitive prefix, and return 422 `invalid_request` for invalid or unknown query parameters.
5. Methods other than GET on this path return 405 `method_not_allowed`; exporting never changes inventory or holds.
---
Feature: SKU alias directory
Add a separate lookup directory for supplier-specific item names.

1. `POST /v1/sku-aliases` accepts `{"alias": "SUP-42", "sku": "A"}` and returns 201 with those two fields.
2. Aliases are case-sensitive strings of 1 through 40 letters, digits, or hyphens; invalid fields are 422 `invalid_request`, and an unknown target SKU is 404 `not_found`.
3. An alias already registered returns 409 `conflict`, even when the target is unchanged; aliases have their own namespace.
4. `GET /v1/sku-aliases/<alias>` returns 200 with `alias` and the canonical `sku`; `DELETE /v1/sku-aliases/<alias>` returns 204; either returns 404 `not_found` for an unknown alias.
5. Alias resolution occurs only through this directory; callers must use the returned canonical SKU in inventory operations.
---
Feature: Item tag metadata
Let operators maintain searchable tags separately from stock records.

1. `PUT /v1/item-tags/<sku>` accepts `{"tags": ["fragile", "seasonal"]}` and returns 200 with `sku` and the tags sorted lexicographically.
2. Allow 0 through 10 distinct tags, each containing 1 through 24 lowercase letters, digits, or hyphens; duplicates and invalid values return 422 `invalid_request`.
3. An unknown SKU returns 404 `not_found`; replacing tags is atomic, and an empty array removes all tags.
4. `GET /v1/item-tags/<sku>` returns 200 with `sku` and `tags`, defaulting to an empty array for an existing item without metadata.
5. `GET /v1/tag-search?tag=<tag>` returns 200 with `{"skus": [...]}` sorted by SKU, or 422 `invalid_request` for a missing or invalid tag; keep metadata in these responses only.
---
Feature: Partner channel holds
Add a dedicated reservation hold endpoint for partner orders.

1. `POST /v1/partner-holds` accepts `{"partnerId": "P-1", "quantities": {"A": 2, "B": 1}, "ttlSeconds": 120}` and returns 201 with `id`, `partnerId`, `quantities`, and an ISO 8601 UTC `expiresAt`.
2. A hold may cover at most 3 SKUs; more is 422 `invalid_request`; require at least one SKU in the `quantities` object.
3. Require a partnerId of 1 through 40 letters, digits, or hyphens, positive integer quantities, and an integer ttlSeconds from 30 through 300; booleans and invalid fields are 422 `invalid_request`.
4. Unknown SKU is 404 `not_found`; insufficient available stock is 409 `insufficient_stock`; either failure holds nothing, while success holds every requested quantity atomically until expiry.
5. `DELETE /v1/partner-holds/<id>` releases an active partner hold and returns 204; unknown, released, or expired partner holds return 404 `not_found`; partner hold IDs belong only to this endpoint family.
---
Feature: Health and readiness probes
Expose small operational probes for service monitoring.

1. `GET /v1/health` returns 200 with exactly `{"status": "ok"}` whenever the HTTP process can serve requests.
2. `GET /v1/readiness` returns 200 with exactly `{"status": "ready"}` after the inventory store is initialized.
3. Before initialization completes, readiness returns 503 `service_unavailable` in the standard JSON error envelope with a nonempty message.
4. Both probes set `Cache-Control: no-store`, require no request body, and reveal no item counts, SKUs, or reservation identifiers.
5. Methods other than GET on either path return 405 `method_not_allowed`; probes never acquire stock or modify inventory.
---
Feature: Operator item notes
Add an append-only note log for each inventory item.

1. `POST /v1/item-notes/<sku>` accepts `{"text": "Check packaging"}` and returns 201 with `id`, `sku`, `text`, and an ISO 8601 UTC `createdAt`.
2. Require text containing 1 through 500 Unicode characters after trimming surrounding whitespace; store the trimmed value, and return 422 `invalid_request` for blank, oversized, or non-string text.
3. Unknown SKU returns 404 `not_found`; allow at most 50 notes per item, with the next addition returning 409 `note_limit_reached`.
4. `GET /v1/item-notes/<sku>` returns 200 with `{"sku": "<sku>", "notes": [...]}` in insertion order, using an empty array when no notes exist; unknown SKU is 404 `not_found`.
5. PUT, PATCH, and DELETE on this path return 405 `method_not_allowed`; notes appear only in note responses and never affect stock calculations.
---
Feature: Warehouse bin labels
Store an item's physical bin label as separate warehouse metadata.

1. `PUT /v1/item-bins/<sku>` accepts `{"bin": "R2-S4"}` and returns 200 with `sku` and `bin`, replacing any previous label.
2. A bin label contains 1 through 16 uppercase letters, digits, or hyphens; invalid or missing values return 422 `invalid_request`, and an unknown SKU returns 404 `not_found`.
3. Multiple items may share a bin; labels describe location only and never partition or change stock quantities.
4. `GET /v1/item-bins/<sku>` returns 200 with `sku` and `bin`, using null when an existing item has no assigned bin; unknown SKU is 404 `not_found`.
5. `DELETE /v1/item-bins/<sku>` clears the label and returns 204 even when already unassigned; an unknown SKU is 404 `not_found`.
