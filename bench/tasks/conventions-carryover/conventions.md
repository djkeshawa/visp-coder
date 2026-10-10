Our API conventions:

- C1 Lists. Every collection endpoint is paginated with the query parameters `limit` (integer 1..100, default 20) and `cursor`, and returns 200 `{"data": [...], "nextCursor": "<opaque string>" | null}` in creation order; `nextCursor` is null on the last page. An invalid `limit` or an unknown `cursor` is 422 `invalid_request`.
- C2 Audit. Every successful state-changing request appends one entry `{"seq": <integer from 1>, "action": "<resource>.<verb>", "target": "<sku or id>"}` to the audit log, listed by `GET /v1/audit` (paginated per C1). A request that changes nothing, such as an idempotent replay or an error, appends nothing.
- C3 Money. An amount of money is a non-negative integer number of cents in a field whose name ends in `Cents`, such as `priceCents`; never a float or a string.
- C4 Deletion. Nothing is hard-deleted. After a resource is deleted, every request on its path, including another delete, is 410 `gone`, and lists omit it.
