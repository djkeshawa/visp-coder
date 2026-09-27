Feature: Raise the item limit
Our suppliers now ship pallets of up to 50000 units, so the item limit needs to go up.

1. Items hold at most 50000 units, replacing the 10000 limit: creating an item with quantity above 50000 is 422 `invalid_request`; 50000 exactly is accepted.
2. Update the tests and the README contract for the new limit.
