import json
import threading
from urllib.parse import parse_qsl, urlsplit
from http.server import BaseHTTPRequestHandler

from . import validation
from .errors import ApiError

ROUTES = (
    (("v1", "items"), {"GET": "list_items", "POST": "create_item"}),
    (("v1", "items", None), {"GET": "get_item", "DELETE": "retire"}),
    (("v1", "items", None, "price"), {"PUT": "set_price"}),
    (("v1", "reservations"), {"GET": "list_reservations", "POST": "create_reservation"}),
    (("v1", "reservations", None), {"DELETE": "release"}),
    (("v1", "reservations", None, "confirm"), {"POST": "confirm"}),
    (("v1", "reservations", None, "total"), {"GET": "total"}),
    (("v1", "audit"), {"GET": "list_audit"}),
)


def match(parts):
    for pattern, methods in ROUTES:
        if len(pattern) == len(parts) and all(p is None or p == q for p, q in zip(pattern, parts)):
            return methods, [q for p, q in zip(pattern, parts) if p is None]
    return None, []


def make_handler(store):
    cursors = {}
    cursor_lock = threading.Lock()

    def page(rows, query):
        with cursor_lock:
            return validation.page(rows, query, cursors)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, body=None):
            data = b"" if body is None else json.dumps(body).encode()
            self.send_response(status)
            if body is not None:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def json_body(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            media = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if media != "application/json":
                raise ApiError(415, "unsupported_media_type")
            try:
                value = json.loads(raw)
            except ValueError:
                raise ApiError(400, "invalid_json")
            if not isinstance(value, dict):
                raise ApiError(422, "invalid_request")
            return value

        def create_item(self):
            sku, quantity, price_cents = validation.item_request(self.json_body())
            return 201, store.create_item(sku, quantity, price_cents)

        def get_item(self, sku):
            return 200, store.get_item(sku)

        def list_items(self):
            return 200, page(store.list_items(), self.query)

        def set_price(self, sku):
            return 200, store.set_price(sku, validation.price_request(self.json_body()))

        def retire(self, sku):
            store.retire(sku)
            return 204, None

        def list_reservations(self):
            status = validation.status_filter(self.query)
            return 200, page(store.list_reservations(status), self.query)

        def total(self, reservation_id):
            return 200, store.total(reservation_id)

        def list_audit(self):
            return 200, page(store.list_audit(), self.query)

        def create_reservation(self):
            body = self.json_body()
            sku, quantity, ttl = validation.reservation_request(body)
            return 201, store.reserve(sku, quantity, ttl, self.headers.get("Idempotency-Key"), body)

        def release(self, reservation_id):
            store.release(reservation_id)
            return 204, None

        def confirm(self, reservation_id):
            return 200, store.confirm(reservation_id)

        def dispatch(self, method):
            try:
                url = urlsplit(self.path)
                self.query = dict(parse_qsl(url.query, keep_blank_values=True))
                parts = tuple(url.path.strip("/").split("/"))
                methods, args = match(parts)
                if methods is None:
                    raise ApiError(404, "not_found")
                if method not in methods:
                    raise ApiError(405, "method_not_allowed")
                status, body = getattr(self, methods[method])(*args)
            except ApiError as error:
                status = error.status
                body = {"error": {"code": error.code, "message": error.code.replace("_", " ")}}
            self.send(status, body)

        def do_GET(self):
            self.dispatch("GET")

        def do_POST(self):
            self.dispatch("POST")

        def do_PUT(self):
            self.dispatch("PUT")

        def do_PATCH(self):
            self.dispatch("PATCH")

        def do_DELETE(self):
            self.dispatch("DELETE")

    return Handler
