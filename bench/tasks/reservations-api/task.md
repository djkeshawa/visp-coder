Build a small local inventory reservation HTTP API.

Contract (follow it exactly; it will be tested over HTTP):

- Start command: `./start.sh <port>` starts the server on 127.0.0.1:<port> and keeps running in the foreground. Use only the standard library of Python 3.10 or Node.js 22; no dependency downloads. State is in memory.
- Items:
  - `POST /v1/items` with JSON `{"sku": "<1-64 chars of letters, digits or ->", "quantity": <integer >= 0>}` creates an item and returns 201 with `{"sku", "quantity", "available"}`. An existing SKU returns 409 `conflict`.
  - `GET /v1/items/<sku>` returns 200 with `{"sku", "quantity", "available"}`, where `available` is `quantity` minus the quantities of active (unexpired, unconfirmed, not released) reservations. Unknown SKU returns 404 `not_found`.
- Reservations:
  - `POST /v1/reservations` with JSON `{"sku", "quantity": <integer >= 1>, "ttlSeconds": <integer 1..3600>}` holds stock and returns 201 with `{"id": "<string>", "sku", "quantity", "expiresAt": "<ISO 8601 UTC>"}`. Unknown SKU returns 404 `not_found`. Not enough available stock returns 409 `insufficient_stock` and holds nothing.
  - Optional header `Idempotency-Key`: repeating a request with the same key and the same body returns the original 201 response (same `id`) without holding stock again. The same key with a different body returns 422 `idempotency_mismatch`.
  - `DELETE /v1/reservations/<id>` releases an active reservation and returns 204. Unknown, already released, confirmed or expired reservations return 404 `not_found`.
  - `POST /v1/reservations/<id>/confirm` returns 200 with `{"id", "status": "confirmed"}` and permanently reduces the item's `quantity` by the reserved amount. Confirming again returns 409 `already_confirmed`. Confirming an expired reservation returns 410 `expired`. Unknown or released reservations return 404 `not_found`.
  - A reservation expires at `expiresAt`; expired reservations no longer reduce `available`.
- Concurrency: simultaneous reservation requests must never hold more stock than is available.
- Errors return JSON `{"error": {"code": "<code>", "message": "<human readable>"}}`:
  - 400 `invalid_json`: body is not valid JSON.
  - 422 `invalid_request`: valid JSON with the wrong shape or values (not an object, missing or wrongly typed fields, out-of-range numbers, booleans used as numbers, invalid SKU).
  - 415 `unsupported_media_type`: a request with a body whose Content-Type is not `application/json` (parameters and letter case allowed).
  - 404 `not_found`: unknown path. 405 `method_not_allowed`: known path with the wrong method.
- Include a README with run instructions and your own automated tests.
