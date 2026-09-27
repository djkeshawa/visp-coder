"""In-memory inventory with time-limited reservations, prices, retirement and an audit log."""
import json
import threading
import uuid
from datetime import datetime, timedelta, timezone

from .errors import ApiError


def now():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.isoformat().replace("+00:00", "Z")


class Store:
    """All state lives here; every public method holds the lock for its whole operation."""

    def __init__(self):
        self.lock = threading.Lock()
        self.items = {}
        self.reservations = {}
        self.keys = {}
        self.audit = []

    def _record(self, action, target):
        self.audit.append({"seq": len(self.audit) + 1, "action": action, "target": target})

    def _active(self, reservation):
        return reservation["state"] == "active" and reservation["expires"] > now()

    def _status(self, reservation):
        if reservation["state"] == "active" and reservation["expires"] <= now():
            return "expired"
        return reservation["state"]

    def _available(self, sku):
        held = sum(
            r["quantity"] for r in self.reservations.values() if r["sku"] == sku and self._active(r)
        )
        return self.items[sku]["quantity"] - held

    def _view(self, sku):
        item = self.items[sku]
        return {
            "sku": sku,
            "quantity": item["quantity"],
            "available": self._available(sku),
            "priceCents": item["priceCents"],
        }

    def _live(self, sku):
        if sku not in self.items:
            raise ApiError(404, "not_found")
        if self.items[sku]["retired"]:
            raise ApiError(410, "gone")
        return self.items[sku]

    def create_item(self, sku, quantity, price_cents):
        with self.lock:
            if sku in self.items:
                raise ApiError(409, "conflict")
            self.items[sku] = {"quantity": quantity, "priceCents": price_cents, "retired": False}
            self._record("item.create", sku)
            return self._view(sku)

    def get_item(self, sku):
        with self.lock:
            self._live(sku)
            return self._view(sku)

    def list_items(self):
        with self.lock:
            return [self._view(sku) for sku, item in self.items.items() if not item["retired"]]

    def set_price(self, sku, price_cents):
        with self.lock:
            self._live(sku)["priceCents"] = price_cents
            self._record("item.price", sku)
            return self._view(sku)

    def retire(self, sku):
        with self.lock:
            item = self._live(sku)
            if any(r["sku"] == sku and self._active(r) for r in self.reservations.values()):
                raise ApiError(409, "conflict")
            item["retired"] = True
            self._record("item.delete", sku)

    def reserve(self, sku, quantity, ttl, key=None, body=None):
        canonical = json.dumps(body, sort_keys=True)
        with self.lock:
            if key and key in self.keys:
                if self.keys[key][0] != canonical:
                    raise ApiError(422, "idempotency_mismatch")
                return self.keys[key][1]
            self._live(sku)
            if self._available(sku) < quantity:
                raise ApiError(409, "insufficient_stock")
            reservation_id = uuid.uuid4().hex
            expires = now() + timedelta(seconds=ttl)
            self.reservations[reservation_id] = {
                "sku": sku,
                "quantity": quantity,
                "expires": expires,
                "state": "active",
            }
            result = {"id": reservation_id, "sku": sku, "quantity": quantity, "expiresAt": iso(expires)}
            if key:
                self.keys[key] = (canonical, result)
            self._record("reservation.create", reservation_id)
            return result

    def release(self, reservation_id):
        with self.lock:
            reservation = self.reservations.get(reservation_id)
            if not reservation or not self._active(reservation):
                raise ApiError(404, "not_found")
            reservation["state"] = "released"
            self._record("reservation.release", reservation_id)

    def confirm(self, reservation_id):
        with self.lock:
            reservation = self.reservations.get(reservation_id)
            if not reservation or reservation["state"] == "released":
                raise ApiError(404, "not_found")
            if reservation["state"] == "confirmed":
                raise ApiError(409, "already_confirmed")
            if reservation["expires"] <= now():
                raise ApiError(410, "expired")
            reservation["state"] = "confirmed"
            self.items[reservation["sku"]]["quantity"] -= reservation["quantity"]
            self._record("reservation.confirm", reservation_id)
            return {"id": reservation_id, "status": "confirmed"}

    def total(self, reservation_id):
        with self.lock:
            reservation = self.reservations.get(reservation_id)
            if not reservation:
                raise ApiError(404, "not_found")
            price = self.items[reservation["sku"]]["priceCents"]
            return {"id": reservation_id, "totalCents": reservation["quantity"] * price}

    def list_reservations(self, status=None):
        with self.lock:
            rows = []
            for reservation_id, r in self.reservations.items():
                current = self._status(r)
                if status is None or current == status:
                    rows.append({
                        "id": reservation_id,
                        "sku": r["sku"],
                        "quantity": r["quantity"],
                        "status": current,
                        "expiresAt": iso(r["expires"]),
                    })
            return rows

    def list_audit(self):
        with self.lock:
            return list(self.audit)
