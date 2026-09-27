This repository already contains a working inventory reservation HTTP API; its contract is in README.md.

A few ground rules about how we build this service, and I want these kept for the rest of this project, not just today. Collection endpoints are paginated with `limit` (integer 1..100, default 20) and `cursor` query parameters and return 200 `{"data": [...], "nextCursor": "<opaque string>" | null}` in creation order, with `nextCursor` null on the last page and 422 `invalid_request` for an invalid `limit` or an unknown `cursor`. Every successful state-changing request appends one entry `{"seq": <integer from 1>, "action": "<resource>.<verb>", "target": "<sku or id>"}` to an audit log listed by `GET /v1/audit` (paginated the same way); a request that changes nothing, such as an idempotent replay or an error, appends nothing. Money is always a non-negative integer number of cents in a field whose name ends in `Cents`, such as `priceCents`, never a float or a string. And we never hard-delete anything: once a resource is deleted, every request on its path, including another delete, answers 410 `gone`, and lists leave it out.

The change:

1. New `GET /v1/items` lists items, each as `{"sku", "quantity", "available"}`, paginated as above.
2. Add the audit log and `GET /v1/audit`. The existing state-changing requests record `item.create` (target: the SKU), `reservation.create`, `reservation.release` and `reservation.confirm` (target: the reservation id).
3. Keep all existing behavior, keep the existing tests passing and add tests for the new behavior. Update the README contract.

Use only the Python standard library. Run the service with `./start.sh <port>` as before.
