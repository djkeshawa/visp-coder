import unittest
from concurrent.futures import ThreadPoolExecutor

from inventory import validation
from inventory.errors import ApiError
from inventory.store import Store


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.store.create_item("A", 10)
        self.store.create_item("B", 10)

    def assert_error(self, status, code, fn, *args):
        with self.assertRaises(ApiError) as raised:
            fn(*args)
        self.assertEqual((raised.exception.status, raised.exception.code), (status, code))

    def reserve(self, lines, bundle=True, key=None):
        body = {"lines": lines, "ttlSeconds": 60}
        return self.store.reserve(lines, 60, bundle, key, body)

    def test_archive_preserves_reservations(self):
        first = self.reserve([("A", 2)], False)
        second = self.reserve([("A", 3)], False)
        archived = self.store.archive("A")
        self.assertTrue(archived["archived"])
        self.assertEqual(archived["available"], 5)
        self.assertEqual(self.store.archive("A"), archived)
        self.assert_error(409, "item_archived", self.reserve, [("A", 1)], False)
        self.store.confirm(first["id"])
        self.store.release(second["id"])
        self.assertEqual(self.store.get_item("A"), {
            "sku": "A", "quantity": 8, "available": 8, "archived": True})

    def test_bundle_rejection_is_atomic(self):
        self.store.archive("B")
        before = self.store.get_item("A")
        self.assert_error(409, "item_archived", self.reserve, [("A", 2), ("B", 1)])
        self.assertEqual(self.store.get_item("A"), before)
        self.assertEqual(self.store.reservations, {})

    def test_bundle_lifecycle_and_idempotency(self):
        lines = [("B", 3), ("A", 2)]
        result = self.reserve(lines, key="key")
        self.assertEqual(result["lines"], [{"sku": "B", "quantity": 3}, {"sku": "A", "quantity": 2}])
        self.assertEqual(self.reserve(lines, key="key"), result)
        self.assert_error(422, "idempotency_mismatch", self.reserve, [("A", 1)], True, "key")
        self.store.confirm(result["id"])
        self.assertEqual(self.store.get_item("B")["quantity"], 7)
        other = self.reserve([("A", 2), ("B", 2)])
        self.store.release(other["id"])
        self.assertEqual(self.store.get_item("A")["available"], 8)
        self.assertEqual(self.store.get_item("B")["available"], 7)

    def test_restock_boundary_and_holds(self):
        self.store.create_item("FULL", 9998)
        self.reserve([("FULL", 10)])
        before = self.store.get_item("FULL")
        self.assert_error(422, "invalid_request", self.store.restock, "FULL", 3)
        self.assertEqual(self.store.get_item("FULL"), before)
        self.assertEqual(self.store.restock("FULL", 2), {
            "sku": "FULL", "quantity": 10000, "available": 9990, "archived": False})
        self.assert_error(422, "invalid_request", self.store.create_item, "TOO-MUCH", 10001)
        self.assert_error(404, "not_found", self.store.get_item, "TOO-MUCH")

    def test_validation(self):
        for value in (0, -1, True, 1.5, "1", None):
            with self.subTest(amount=value):
                self.assert_error(422, "invalid_request", validation.restock_request, {"amount": value})
        self.assertEqual(validation.restock_request({"amount": 1}), 1)
        for body in ({}, {"lines": []}, {"lines": [{"sku": "A", "quantity": True}], "ttlSeconds": 60},
                     {"lines": [{"sku": "A", "quantity": 1}] * 2, "ttlSeconds": 60},
                     {"lines": [], "sku": "A", "quantity": 1, "ttlSeconds": 60}):
            self.assert_error(422, "invalid_request", validation.lines_request, body)

    def test_concurrent_restock_respects_cap(self):
        self.store.create_item("LIMIT", 9999)

        def attempt(_):
            try:
                self.store.restock("LIMIT", 1)
                return 200
            except ApiError as error:
                return error.status

        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(attempt, range(16)))
        self.assertEqual(statuses.count(200), 1)
        self.assertEqual(statuses.count(422), 15)
        self.assertEqual(self.store.get_item("LIMIT")["quantity"], 10000)

    def test_concurrent_bundles_do_not_overreserve(self):
        def attempt(_):
            try:
                self.reserve([("A", 3), ("B", 3)])
                return 201
            except ApiError as error:
                return error.status

        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(attempt, range(16)))
        self.assertEqual(statuses.count(201), 3)
        self.assertEqual(statuses.count(409), 13)
        self.assertEqual(self.store.get_item("A")["available"], 1)
        self.assertEqual(self.store.get_item("B")["available"], 1)
