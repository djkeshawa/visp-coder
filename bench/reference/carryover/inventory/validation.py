import re

from .errors import ApiError

SKU = re.compile(r"^[A-Za-z0-9-]{1,64}$")
STATUSES = ("active", "confirmed", "released", "expired")


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def price(value):
    if not is_int(value) or value < 0:
        raise ApiError(422, "invalid_request")
    return value


def item_request(body):
    sku, quantity = body.get("sku"), body.get("quantity")
    if not isinstance(sku, str) or not SKU.match(sku) or not is_int(quantity) or quantity < 0:
        raise ApiError(422, "invalid_request")
    return sku, quantity, price(body.get("priceCents", 0))


def price_request(body):
    return price(body.get("priceCents"))


def reservation_request(body):
    sku, quantity, ttl = body.get("sku"), body.get("quantity"), body.get("ttlSeconds")
    if not isinstance(sku, str) or not is_int(quantity) or quantity < 1:
        raise ApiError(422, "invalid_request")
    if not is_int(ttl) or not 1 <= ttl <= 3600:
        raise ApiError(422, "invalid_request")
    return sku, quantity, ttl


def status_filter(query):
    status = query.get("status")
    if status is not None and status not in STATUSES:
        raise ApiError(422, "invalid_request")
    return status


def page(rows, query, cursors):
    """Paginate rows per the list convention; cursors maps issued cursor strings to offsets."""
    raw_limit = query.get("limit", "20")
    if not raw_limit.isdigit() or not 1 <= int(raw_limit) <= 100:
        raise ApiError(422, "invalid_request")
    limit = int(raw_limit)
    start = 0
    if "cursor" in query:
        if query["cursor"] not in cursors:
            raise ApiError(422, "invalid_request")
        start = cursors[query["cursor"]]
    end = start + limit
    next_cursor = None
    if end < len(rows):
        next_cursor = f"c{len(cursors) + 1}"
        cursors[next_cursor] = end
    return {"data": rows[start:end], "nextCursor": next_cursor}
