"""Reference implementation used only to validate the reservations oracle."""
import json
import re
import sys
import threading
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
ITEMS = {}
RESERVATIONS = {}
KEYS = {}
SKU = re.compile(r"^[A-Za-z0-9-]{1,64}$")


def now():
    return datetime.now(timezone.utc)


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def active(reservation):
    return reservation["state"] == "active" and reservation["expires"] > now()


def available(sku):
    held = sum(r["quantity"] for r in RESERVATIONS.values() if r["sku"] == sku and active(r))
    return ITEMS[sku] - held


def view(sku):
    return {"sku": sku, "quantity": ITEMS[sku], "available": available(sku)}


class Failure(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status, self.code = status, code


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

    def body(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            raise Failure(415, "unsupported_media_type")
        try:
            value = json.loads(raw)
        except ValueError:
            raise Failure(400, "invalid_json")
        if not isinstance(value, dict):
            raise Failure(422, "invalid_request")
        return value

    def route(self, method):
        path = self.path.rstrip("/")
        parts = path.split("/")
        if path == "/v1/items":
            if method != "POST":
                raise Failure(405, "method_not_allowed")
            body = self.body()
            sku, quantity = body.get("sku"), body.get("quantity")
            if not isinstance(sku, str) or not SKU.match(sku) or not is_int(quantity) or quantity < 0:
                raise Failure(422, "invalid_request")
            with LOCK:
                if sku in ITEMS:
                    raise Failure(409, "conflict")
                ITEMS[sku] = quantity
                return 201, view(sku)
        if len(parts) == 4 and parts[1:3] == ["v1", "items"]:
            if method != "GET":
                raise Failure(405, "method_not_allowed")
            with LOCK:
                if parts[3] not in ITEMS:
                    raise Failure(404, "not_found")
                return 200, view(parts[3])
        if path == "/v1/reservations":
            if method != "POST":
                raise Failure(405, "method_not_allowed")
            body = self.body()
            sku, quantity, ttl = body.get("sku"), body.get("quantity"), body.get("ttlSeconds")
            if not isinstance(sku, str) or not is_int(quantity) or quantity < 1 or not is_int(ttl) or not 1 <= ttl <= 3600:
                raise Failure(422, "invalid_request")
            key = self.headers.get("Idempotency-Key")
            canonical = json.dumps(body, sort_keys=True)
            with LOCK:
                if key and key in KEYS:
                    if KEYS[key][0] != canonical:
                        raise Failure(422, "idempotency_mismatch")
                    return 201, KEYS[key][1]
                if sku not in ITEMS:
                    raise Failure(404, "not_found")
                if available(sku) < quantity:
                    raise Failure(409, "insufficient_stock")
                reservation_id = uuid.uuid4().hex
                expires = now() + timedelta(seconds=ttl)
                RESERVATIONS[reservation_id] = {"sku": sku, "quantity": quantity, "expires": expires, "state": "active"}
                result = {"id": reservation_id, "sku": sku, "quantity": quantity, "expiresAt": expires.isoformat().replace("+00:00", "Z")}
                if key:
                    KEYS[key] = (canonical, result)
                return 201, result
        if len(parts) == 4 and parts[1:3] == ["v1", "reservations"]:
            if method != "DELETE":
                raise Failure(405, "method_not_allowed")
            with LOCK:
                reservation = RESERVATIONS.get(parts[3])
                if not reservation or not active(reservation):
                    raise Failure(404, "not_found")
                reservation["state"] = "released"
                return 204, None
        if len(parts) == 5 and parts[1:3] == ["v1", "reservations"] and parts[4] == "confirm":
            if method != "POST":
                raise Failure(405, "method_not_allowed")
            with LOCK:
                reservation = RESERVATIONS.get(parts[3])
                if not reservation or reservation["state"] == "released":
                    raise Failure(404, "not_found")
                if reservation["state"] == "confirmed":
                    raise Failure(409, "already_confirmed")
                if reservation["expires"] <= now():
                    raise Failure(410, "expired")
                reservation["state"] = "confirmed"
                ITEMS[reservation["sku"]] -= reservation["quantity"]
                return 200, {"id": parts[3], "status": "confirmed"}
        raise Failure(404, "not_found")

    def handle_method(self, method):
        try:
            status, body = self.route(method)
        except Failure as failure:
            status, body = failure.status, {"error": {"code": failure.code, "message": failure.code.replace("_", " ")}}
        self.send(status, body)

    def do_GET(self):
        self.handle_method("GET")

    def do_POST(self):
        self.handle_method("POST")

    def do_PUT(self):
        self.handle_method("PUT")

    def do_DELETE(self):
        self.handle_method("DELETE")


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
