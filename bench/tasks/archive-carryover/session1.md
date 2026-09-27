This repository already contains a working inventory reservation HTTP API; its contract is in README.md. Add item archiving with this feature specification:

1. `POST /v1/items/<sku>/archive` archives an item and returns 200 with the item, including `"archived": true`. Every item representation includes `archived`, false by default. Archiving an archived item returns 200 again. Unknown SKU is 404 `not_found`.
2. An archived item cannot be reserved: `POST /v1/reservations` for it returns 409 `item_archived` and holds nothing. Existing reservations of it are unaffected.
3. Items hold at most 10000 units: creating an item with quantity above 10000 is 422 `invalid_request`.
4. Keep existing behavior and tests passing, add tests for the new behavior, and update the README contract.

Use only the Python standard library. Run the service with `./start.sh <port>` as before.
