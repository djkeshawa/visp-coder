# Inventory reservations API

Run: `./start.sh <port>` (Python 3.10, standard library only). Tests: `python3 -m unittest discover -s tests`.

Layout: `inventory/store.py` holds state and rules, `inventory/validation.py` request validation and pagination, `inventory/http.py` routing and the HTTP contract, `server.py` the entry point.

Reference for the `conventions-carryover` benchmark: the state after both sessions.

## Conventions

- Lists take `limit` (1..100, default 20) and `cursor`, and return `{"data": [...], "nextCursor": <string or null>}` in creation order. Invalid `limit` or unknown `cursor` → 422 `invalid_request`.
- Every successful state-changing request appends `{"seq", "action", "target"}` to the audit log.
- Money is an integer number of cents in a field ending in `Cents`.
- Nothing is hard-deleted: a deleted resource's path answers 410 `gone`, and lists omit it.

## Contract

- `POST /v1/items` `{"sku": "<1-64 letters, digits or ->", "quantity": <int >= 0>, "priceCents": <int >= 0, optional, default 0>}` → 201 item `{"sku","quantity","available","priceCents"}`; existing SKU → 409 `conflict`.
- `GET /v1/items` → items, paginated. Retired items are omitted.
- `GET /v1/items/<sku>` → 200 item; `available` is `quantity` minus active (unexpired, unconfirmed, unreleased) reservations. Unknown → 404 `not_found`; retired → 410 `gone`.
- `PUT /v1/items/<sku>/price` `{"priceCents"}` → 200 item.
- `DELETE /v1/items/<sku>` retires the item → 204; with an active reservation → 409 `conflict`; retired → 410 `gone`.
- `POST /v1/reservations` `{"sku","quantity": <int >= 1>,"ttlSeconds": <int 1..3600>}` → 201 `{"id","sku","quantity","expiresAt"}`. Unknown SKU → 404; retired → 410; not enough available stock → 409 `insufficient_stock` and nothing is held.
- `Idempotency-Key` header: the same key and body return the original 201 without holding stock again; the same key with a different body → 422 `idempotency_mismatch`.
- `GET /v1/reservations[?status=active|confirmed|released|expired]` → `{"id","sku","quantity","status","expiresAt"}` rows, paginated; another status → 422.
- `GET /v1/reservations/<id>/total` → 200 `{"id","totalCents"}` at current prices. Unknown → 404.
- `DELETE /v1/reservations/<id>` releases an active reservation → 204. Unknown, released, confirmed or expired → 404.
- `POST /v1/reservations/<id>/confirm` → 200 `{"id","status":"confirmed"}` and permanently reduces the item's quantity. Again → 409 `already_confirmed`; expired → 410 `expired`; unknown or released → 404.
- `GET /v1/audit` → `{"seq","action","target"}` entries, paginated.
- Concurrent reservations never hold more than is available.
- Errors: `{"error": {"code", "message"}}`. 400 `invalid_json`; 422 `invalid_request`; 415 `unsupported_media_type`; 404 unknown path; 405 known path with the wrong method.
