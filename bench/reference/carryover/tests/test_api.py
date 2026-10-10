import http.client
import json
import os
import socket
import subprocess
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.proc = subprocess.Popen([os.path.join(ROOT, "start.sh"), str(cls.port)])
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", cls.port), 0.2).close()
                return
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=data, headers=headers or {"Content-Type": "application/json"})
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        return response.status, json.loads(raw) if raw else None

    def test_item_lifecycle(self):
        self.assertEqual(self.call("POST", "/v1/items", {"sku": "T-1", "quantity": 3})[0], 201)
        self.assertEqual(self.call("POST", "/v1/items", {"sku": "T-1", "quantity": 3})[0], 409)
        self.assertEqual(self.call("GET", "/v1/items/T-1")[1], {"sku": "T-1", "quantity": 3, "available": 3, "priceCents": 0})

    def test_reserve_confirm_release(self):
        self.call("POST", "/v1/items", {"sku": "T-2", "quantity": 5})
        status, body = self.call("POST", "/v1/reservations", {"sku": "T-2", "quantity": 2, "ttlSeconds": 60})
        self.assertEqual(status, 201)
        self.assertEqual(self.call("GET", "/v1/items/T-2")[1]["available"], 3)
        self.assertEqual(self.call("POST", f"/v1/reservations/{body['id']}/confirm", {})[0], 200)
        self.assertEqual(self.call("GET", "/v1/items/T-2")[1], {"sku": "T-2", "quantity": 3, "available": 3, "priceCents": 0})
        other = self.call("POST", "/v1/reservations", {"sku": "T-2", "quantity": 1, "ttlSeconds": 60})[1]
        self.assertEqual(self.call("DELETE", f"/v1/reservations/{other['id']}")[0], 204)

    def test_errors(self):
        self.assertEqual(self.call("POST", "/v1/reservations", {"sku": "none", "quantity": 1, "ttlSeconds": 5})[0], 404)
        self.assertEqual(self.call("PATCH", "/v1/reservations")[0], 405)
        self.assertEqual(self.call("POST", "/v1/items", {"sku": "T-3", "quantity": 1}, {"Content-Type": "text/plain"})[0], 415)

    def test_items_list_pages(self):
        for i in range(3):
            self.call("POST", "/v1/items", {"sku": f"PG-{i}", "quantity": 1})
        status, first = self.call("GET", "/v1/items?limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(len(first["data"]), 1)
        rest = self.call("GET", f"/v1/items?limit=100&cursor={first['nextCursor']}")[1]
        self.assertIsNone(rest["nextCursor"])
        self.assertEqual(self.call("GET", "/v1/items?limit=0")[0], 422)
        self.assertEqual(self.call("GET", "/v1/items?cursor=nope")[0], 422)

    def test_audit(self):
        self.call("POST", "/v1/items", {"sku": "AU-1", "quantity": 1})
        entries = self.call("GET", "/v1/audit?limit=100")[1]["data"]
        self.assertIn({"action": "item.create", "target": "AU-1"},
                      [{"action": e["action"], "target": e["target"]} for e in entries])
        self.assertEqual([e["seq"] for e in entries], list(range(1, len(entries) + 1)))

    def test_prices_and_totals(self):
        self.assertEqual(self.call("POST", "/v1/items", {"sku": "PR-1", "quantity": 5, "priceCents": 150})[1]["priceCents"], 150)
        self.assertEqual(self.call("PUT", "/v1/items/PR-1/price", {"priceCents": 200})[1]["priceCents"], 200)
        self.assertEqual(self.call("PUT", "/v1/items/PR-1/price", {"priceCents": 1.5})[0], 422)
        reservation = self.call("POST", "/v1/reservations", {"sku": "PR-1", "quantity": 2, "ttlSeconds": 60})[1]
        self.assertEqual(self.call("GET", f"/v1/reservations/{reservation['id']}/total")[1],
                         {"id": reservation["id"], "totalCents": 400})

    def test_retire(self):
        self.call("POST", "/v1/items", {"sku": "RT-1", "quantity": 1})
        held = self.call("POST", "/v1/reservations", {"sku": "RT-1", "quantity": 1, "ttlSeconds": 60})[1]
        self.assertEqual(self.call("DELETE", "/v1/items/RT-1")[0], 409)
        self.call("DELETE", f"/v1/reservations/{held['id']}")
        self.assertEqual(self.call("DELETE", "/v1/items/RT-1")[0], 204)
        self.assertEqual(self.call("GET", "/v1/items/RT-1")[1]["error"]["code"], "gone")
        self.assertEqual(self.call("DELETE", "/v1/items/RT-1")[0], 410)

    def test_reservations_list(self):
        self.call("POST", "/v1/items", {"sku": "RL-1", "quantity": 5})
        created = self.call("POST", "/v1/reservations", {"sku": "RL-1", "quantity": 1, "ttlSeconds": 60})[1]
        rows = self.call("GET", "/v1/reservations?status=active&limit=100")[1]["data"]
        self.assertIn(created["id"], [row["id"] for row in rows])
        self.assertTrue(all(row["status"] == "active" for row in rows))
        self.assertEqual(self.call("GET", "/v1/reservations?status=pending")[0], 422)


if __name__ == "__main__":
    unittest.main()
