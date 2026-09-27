Archived items cannot be reserved through any way of reserving: return 409 `item_archived` and hold nothing.
Items hold at most 50000 units (the limit was raised from 10000): anything that would exceed it is 422 `invalid_request`.
