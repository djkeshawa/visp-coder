# Inventory reservations API

Run: `./start.sh <port>` (Python 3.10, standard library only). Tests: `python3 -m unittest discover -s tests`.

Layout: `inventory/store.py` holds state and rules, `inventory/validation.py` request validation, `inventory/http.py` routing and the HTTP contract, `server.py` the entry point.

## Contract

- `POST /v1/items` `{"sku": "<1-64 letters, digits or ->", "quantity": <int 0..10000>}` → 201 `{"sku","quantity","available","archived"}`; existing SKU → 409 `conflict`.
- `GET /v1/items/<sku>` → 200 `{"sku","quantity","available","archived"}`; `available` is `quantity` minus active (unexpired, unconfirmed, unreleased) reservations. Unknown → 404 `not_found`.
- `POST /v1/reservations` `{"sku","quantity": <int >= 1>,"ttlSeconds": <int 1..3600>}` → 201 `{"id","sku","quantity","expiresAt"}`. Unknown SKU → 404; not enough available stock → 409 `insufficient_stock` and nothing is held.
- `Idempotency-Key` header: the same key and body return the original 201 without holding stock again; the same key with a different body → 422 `idempotency_mismatch`.
- `DELETE /v1/reservations/<id>` releases an active reservation → 204. Unknown, released, confirmed or expired → 404.
- `POST /v1/reservations/<id>/confirm` → 200 `{"id","status":"confirmed"}` and permanently reduces the item's quantity. Again → 409 `already_confirmed`; expired → 410 `expired`; unknown or released → 404.
- Concurrent reservations never hold more than is available.
- Errors: `{"error": {"code", "message"}}`. 400 `invalid_json`; 422 `invalid_request` (wrong shape or values, booleans as numbers, invalid SKU); 415 `unsupported_media_type` for a body whose Content-Type is not `application/json` (parameters and case allowed); 404 unknown path; 405 known path with the wrong method.

## Archiving, bundles and restocking

- Items include `archived`, a boolean initially false. `POST /v1/items/<sku>/archive` returns 200 with the item and sets it to true; repeated archiving returns 200 with the item. Unknown SKU is 404 `not_found`.
- Archived items cannot be newly reserved, singly or in any bundle: 409 `item_archived`, with nothing held. Existing reservations can still expire, be released or be confirmed. An idempotent replay returns the original response without adding holds.
- `POST /v1/reservations` also accepts `{"lines": [{"sku": "A", "quantity": 1}, ...], "ttlSeconds": 60}`. There must be 1..20 lines, with distinct SKUs and positive integer quantities. Use exactly one shape: `sku`/`quantity` or `lines`. Invalid shapes, lines or TTLs return 422 `invalid_request`.
- Bundles return 201 `{"id","lines","expiresAt"}` in request order. Unknown SKU is 404 `not_found`; insufficient available stock is 409 `insufficient_stock`. Validation and every stock check occur before holding anything, under the same lock. Idempotency behaves as for single reservations. Release and confirmation act on every line.
- `POST /v1/items/<sku>/restock` takes `{"amount": <int >= 1>}` and returns 200 with the updated item. Unknown SKU is 404 `not_found`; invalid amounts are 422 `invalid_request`. Existing holds are preserved. This implementation permits restocking an archived item without unarchiving it.
- Total item quantity cannot exceed 10000. Creation above that limit and restocking that would exceed it return 422 `invalid_request` without changes. Reaching exactly 10000 is allowed; active holds do not lower the total used for this limit.
