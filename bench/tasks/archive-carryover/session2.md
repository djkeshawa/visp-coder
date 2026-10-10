Next change to the inventory service in this repository.

1. Bundle reservations. `POST /v1/reservations` also accepts `{"lines": [{"sku": "<sku>", "quantity": <integer >= 1>}, ...], "ttlSeconds": <integer 1..3600>}`: 1 to 20 lines, each SKU at most once. A request must use exactly one shape: either `sku` and `quantity`, or `lines`; both, neither, an empty or oversized `lines`, a repeated SKU, or any invalid line is 422 `invalid_request`.
   - All or nothing: if any line's SKU is unknown the response is 404 `not_found`; if any line lacks available stock it is 409 `insufficient_stock`; in both cases nothing is held.
   - Success returns 201 `{"id": "<string>", "lines": [{"sku", "quantity"}, ...], "expiresAt": "<ISO 8601 UTC>"}` with lines in request order. The response for the single-SKU shape is unchanged.
   - `Idempotency-Key` works for bundles exactly as for single reservations.
2. `POST /v1/items/<sku>/restock` accepts `{"amount": <int >= 1>}`, adds that many units, and returns 200 with the item. Unknown SKU is 404 `not_found`; an invalid amount is 422 `invalid_request`.
3. Keep existing behavior and tests passing, add tests for the new behavior, and update the README contract.

Use only the Python standard library. Run the service with `./start.sh <port>` as before.
