Next change to the inventory service in this repository. Our API conventions from before still apply.

1. Prices. Every item has a price, 0 unless given. `POST /v1/items` accepts an optional price, and every item representation includes it. New `PUT /v1/items/<sku>/price` sets an item's price and returns 200 with the item.
2. New `GET /v1/reservations/<id>/total` returns 200 with the reservation's id and its total price: the reserved quantity times the item's current price. Unknown id is 404 `not_found`.
3. New `DELETE /v1/items/<sku>` retires an item and returns 204. An item with an active reservation cannot be retired: 409 `conflict`. An unknown SKU is 404 `not_found`.
4. New `GET /v1/reservations` lists reservations, each as `{"id", "sku", "quantity", "status", "expiresAt"}`, where `status` is `active`, `confirmed`, `released` or `expired` (unconfirmed and unreleased past `expiresAt`). An optional `status` query parameter filters by status; any other value is 422 `invalid_request`.
5. Keep all existing behavior and tests passing (update any test that the new endpoints make obsolete), add tests for the new behavior, and update the README contract.

Use only the Python standard library. Run the service with `./start.sh <port>` as before.
