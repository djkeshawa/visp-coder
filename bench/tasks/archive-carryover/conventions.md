Archived items cannot be reserved through any way of reserving: return 409 `item_archived` and hold nothing.
Items hold at most 10000 units: anything that would exceed this is 422 `invalid_request`.
