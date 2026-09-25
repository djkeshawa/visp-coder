"""Hidden tests for the bundle extension: existing contract (regression), extended rules and new behavior. Usage: hidden_test.py <project_dir>"""
import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
RESULTS = []


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = free_port()


def call(method, path, body=None, headers=None, raw=None, timeout=5):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    hdrs = {"Content-Type": "application/json"} if headers is None else headers
    try:
        conn.request(method, path, body=data, headers=hdrs)
        response = conn.getresponse()
        payload = response.read()
        try:
            parsed = json.loads(payload) if payload else None
        except ValueError:
            parsed = payload.decode(errors="replace")
        return response.status, parsed
    except Exception as error:  # noqa: BLE001
        return None, repr(error)
    finally:
        conn.close()


def check(name, fn):
    try:
        ok, detail = fn()
    except Exception as error:  # noqa: BLE001
        ok, detail = False, repr(error)
    RESULTS.append({"name": name, "passed": bool(ok), "detail": None if ok else detail})


def error(status, body, expected, code):
    ok = (
        status == expected
        and isinstance(body, dict)
        and isinstance(body.get("error"), dict)
        and body["error"].get("code") == code
        and isinstance(body["error"].get("message"), str)
        and body["error"]["message"].strip() != ""
    )
    return ok, {"status": status, "body": body}


def item(sku, quantity):
    return call("POST", "/v1/items", {"sku": sku, "quantity": quantity})


def available(sku):
    status, body = call("GET", f"/v1/items/{sku}")
    return body.get("available") if status == 200 and isinstance(body, dict) else None


def reserve(sku, quantity, ttl=60, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    return call("POST", "/v1/reservations", {"sku": sku, "quantity": quantity, "ttlSeconds": ttl}, headers=headers)


def rid(result):
    return result[1].get("id") if isinstance(result[1], dict) else None


def t_create():
    status, body = item("A-1", 10)
    ok = status == 201 and body == {"sku": "A-1", "quantity": 10, "available": 10}
    return ok, {"status": status, "body": body}


def t_duplicate():
    return error(*item("A-1", 5), 409, "conflict")


def t_get():
    status, body = call("GET", "/v1/items/A-1")
    return status == 200 and body == {"sku": "A-1", "quantity": 10, "available": 10}, {"status": status, "body": body}


def t_reserve_shape():
    item("B-1", 5)
    status, body = reserve("B-1", 2, 60)
    ok = status == 201 and isinstance(body, dict) and isinstance(body.get("id"), str) and body.get("sku") == "B-1" and body.get("quantity") == 2
    if ok:
        expires = datetime.fromisoformat(body["expiresAt"].replace("Z", "+00:00"))
        delta = (expires - datetime.now(timezone.utc)).total_seconds()
        ok = 50 <= delta <= 70
    return ok and available("B-1") == 3, {"status": status, "body": body, "available": available("B-1")}


def t_insufficient():
    item("C-1", 2)
    status, body = reserve("C-1", 3)
    ok, detail = error(status, body, 409, "insufficient_stock")
    return ok and available("C-1") == 2, detail


def t_release():
    item("D-1", 4)
    reservation = rid(reserve("D-1", 3))
    status, _ = call("DELETE", f"/v1/reservations/{reservation}")
    again = call("DELETE", f"/v1/reservations/{reservation}")
    ok = status == 204 and available("D-1") == 4 and error(*again, 404, "not_found")[0]
    return ok, {"status": status, "again": again, "available": available("D-1")}


def t_confirm():
    item("E-1", 5)
    reservation = rid(reserve("E-1", 2))
    status, confirmed = call("POST", f"/v1/reservations/{reservation}/confirm", {})
    got = call("GET", "/v1/items/E-1")
    ok = status == 200 and confirmed == {"id": reservation, "status": "confirmed"} and got[1] == {"sku": "E-1", "quantity": 3, "available": 3}
    return ok, {"status": status, "body": confirmed, "item": got}


def t_confirm_twice():
    item("F-1", 5)
    reservation = rid(reserve("F-1", 1))
    call("POST", f"/v1/reservations/{reservation}/confirm", {})
    return error(*call("POST", f"/v1/reservations/{reservation}/confirm", {}), 409, "already_confirmed")


def t_delete_confirmed():
    item("G-1", 5)
    reservation = rid(reserve("G-1", 1))
    call("POST", f"/v1/reservations/{reservation}/confirm", {})
    ok, detail = error(*call("DELETE", f"/v1/reservations/{reservation}"), 404, "not_found")
    return ok and available("G-1") == 4, detail


def t_expiry():
    item("H-1", 3)
    reservation = rid(reserve("H-1", 2, 1))
    before = available("H-1")
    time.sleep(1.6)
    after = available("H-1")
    confirm = call("POST", f"/v1/reservations/{reservation}/confirm", {})
    ok = before == 1 and after == 3 and error(*confirm, 410, "expired")[0]
    return ok, {"before": before, "after": after, "confirm": confirm}


def t_expired_release():
    item("H-2", 3)
    reservation = rid(reserve("H-2", 1, 1))
    time.sleep(1.4)
    return error(*call("DELETE", f"/v1/reservations/{reservation}"), 404, "not_found")


def t_expired_capacity():
    item("H-3", 2)
    reserve("H-3", 2, 1)
    time.sleep(1.4)
    status, body = reserve("H-3", 2, 60)
    return status == 201, {"status": status, "body": body}


def t_idempotent():
    item("I-1", 5)
    first = reserve("I-1", 2, 60, key="k-1")
    second = reserve("I-1", 2, 60, key="k-1")
    ok = first[0] == 201 and second[0] == 201 and isinstance(first[1], dict) and first[1] == second[1] and available("I-1") == 3
    return ok, {"first": first, "second": second, "available": available("I-1")}


def t_idempotent_mismatch():
    item("I-2", 5)
    reserve("I-2", 1, 60, key="k-2")
    ok, detail = error(*reserve("I-2", 2, 60, key="k-2"), 422, "idempotency_mismatch")
    return ok and available("I-2") == 4, detail


def t_distinct_keys():
    item("I-3", 5)
    a = reserve("I-3", 1, 60, key="k-3a")
    b = reserve("I-3", 1, 60, key="k-3b")
    ok = a[0] == 201 and b[0] == 201 and rid(a) != rid(b) and available("I-3") == 3
    return ok, {"a": a, "b": b}


def t_concurrent():
    item("J-1", 10)
    statuses = []
    lock = threading.Lock()

    def worker():
        status, _ = reserve("J-1", 1, 60)
        with lock:
            statuses.append(status)

    threads = [threading.Thread(target=worker) for _ in range(50)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    ok = statuses.count(201) == 10 and statuses.count(409) == 40 and available("J-1") == 0
    return ok, {"201": statuses.count(201), "409": statuses.count(409), "available": available("J-1")}


def t_concurrent_idempotent():
    item("J-2", 10)
    results = []
    lock = threading.Lock()

    def worker():
        result = reserve("J-2", 3, 60, key="same-key")
        with lock:
            results.append(result)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    ids = {rid(r) for r in results if r[0] == 201}
    ok = all(r[0] == 201 for r in results) and len(ids) == 1 and available("J-2") == 7
    return ok, {"statuses": [r[0] for r in results], "ids": len(ids), "available": available("J-2")}


# Extended checks: contract rules the first 36 checks left untested. Reviewers reported
# real products violating them; they are scored separately ("ext:") for comparability.
def t_ext_reconfirm_after_expiry():
    item("X-1", 3)
    reservation = rid(reserve("X-1", 1, 1))
    call("POST", f"/v1/reservations/{reservation}/confirm", {})
    time.sleep(1.5)
    return error(*call("POST", f"/v1/reservations/{reservation}/confirm", {}), 409, "already_confirmed")


def t_ext_released_after_expiry():
    item("X-2", 3)
    reservation = rid(reserve("X-2", 1, 1))
    call("DELETE", f"/v1/reservations/{reservation}")
    time.sleep(1.5)
    return error(*call("POST", f"/v1/reservations/{reservation}/confirm", {}), 404, "not_found")


def t_ext_idempotency_ttl():
    item("X-3", 5)
    reserve("X-3", 1, 30, key="ext-ttl")
    status, body = reserve("X-3", 1, 40, key="ext-ttl")
    ok, detail = error(status, body, 422, "idempotency_mismatch")
    return ok and available("X-3") == 4, detail


# New behavior: bundle reservations and reservation lookup.
def bundle(lines, ttl=60, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    return call("POST", "/v1/reservations", {"lines": lines, "ttlSeconds": ttl}, headers=headers)


def t_new_bundle_shape():
    item("N-1", 5)
    item("N-2", 5)
    status, body = bundle([{"sku": "N-2", "quantity": 2}, {"sku": "N-1", "quantity": 1}])
    ok = (
        status == 201
        and isinstance(body, dict)
        and isinstance(body.get("id"), str)
        and body.get("lines") == [{"sku": "N-2", "quantity": 2}, {"sku": "N-1", "quantity": 1}]
        and isinstance(body.get("expiresAt"), str)
        and "sku" not in body
    )
    return ok and available("N-1") == 4 and available("N-2") == 3, {"status": status, "body": body}


def t_new_all_or_nothing_stock():
    item("N-3", 5)
    item("N-4", 1)
    status, body = bundle([{"sku": "N-3", "quantity": 2}, {"sku": "N-4", "quantity": 2}])
    ok, detail = error(status, body, 409, "insufficient_stock")
    return ok and available("N-3") == 5 and available("N-4") == 1, detail


def t_new_all_or_nothing_unknown():
    item("N-5", 5)
    status, body = bundle([{"sku": "N-5", "quantity": 1}, {"sku": "NOPE-9", "quantity": 1}])
    ok, detail = error(status, body, 404, "not_found")
    return ok and available("N-5") == 5, detail


def t_new_confirm_bundle():
    item("N-6", 5)
    item("N-7", 5)
    reservation = rid(bundle([{"sku": "N-6", "quantity": 2}, {"sku": "N-7", "quantity": 3}]))
    status, body = call("POST", f"/v1/reservations/{reservation}/confirm", {})
    got6, got7 = call("GET", "/v1/items/N-6")[1], call("GET", "/v1/items/N-7")[1]
    again = call("POST", f"/v1/reservations/{reservation}/confirm", {})
    ok = (
        status == 200
        and body == {"id": reservation, "status": "confirmed"}
        and got6 == {"sku": "N-6", "quantity": 3, "available": 3}
        and got7 == {"sku": "N-7", "quantity": 2, "available": 2}
        and error(*again, 409, "already_confirmed")[0]
    )
    return ok, {"status": status, "items": [got6, got7], "again": again}


def t_new_release_bundle():
    item("N-8", 5)
    item("N-9", 5)
    reservation = rid(bundle([{"sku": "N-8", "quantity": 2}, {"sku": "N-9", "quantity": 3}]))
    status, _ = call("DELETE", f"/v1/reservations/{reservation}")
    ok = status == 204 and available("N-8") == 5 and available("N-9") == 5
    return ok and error(*call("POST", f"/v1/reservations/{reservation}/confirm", {}), 404, "not_found")[0], {"status": status}


def t_new_get_states():
    item("N-10", 9)
    single = rid(reserve("N-10", 1))
    confirmed = rid(reserve("N-10", 1))
    released = rid(reserve("N-10", 1))
    expiring = rid(bundle([{"sku": "N-10", "quantity": 1}], ttl=1))
    call("POST", f"/v1/reservations/{confirmed}/confirm", {})
    call("DELETE", f"/v1/reservations/{released}")
    time.sleep(1.5)
    views = {name: call("GET", f"/v1/reservations/{rid_}") for name, rid_ in
             (("single", single), ("confirmed", confirmed), ("released", released), ("expired", expiring))}
    statuses = {name: view[1].get("status") if isinstance(view[1], dict) else None for name, view in views.items()}
    first = views["single"][1] if isinstance(views["single"][1], dict) else {}
    ok = (
        all(view[0] == 200 for view in views.values())
        and statuses == {"single": "active", "confirmed": "confirmed", "released": "released", "expired": "expired"}
        and first.get("id") == single
        and first.get("lines") == [{"sku": "N-10", "quantity": 1}]
        and isinstance(first.get("expiresAt"), str)
    )
    return ok, {"statuses": statuses, "single": first}


def t_new_bundle_idempotent():
    item("N-11", 5)
    lines = [{"sku": "N-11", "quantity": 2}]
    first = bundle(lines, key="bundle-key")
    second = bundle(lines, key="bundle-key")
    mismatch = bundle([{"sku": "N-11", "quantity": 1}], key="bundle-key")
    ok = (
        first[0] == 201
        and second[0] == 201
        and rid(first) == rid(second)
        and available("N-11") == 3
        and error(*mismatch, 422, "idempotency_mismatch")[0]
    )
    return ok, {"first": first, "second": second, "mismatch": mismatch}


def t_new_concurrent_bundles():
    item("N-12", 4)
    item("N-13", 40)
    results = []
    lock = threading.Lock()

    def worker():
        outcome = bundle([{"sku": "N-13", "quantity": 1}, {"sku": "N-12", "quantity": 1}])
        with lock:
            results.append(outcome[0])

    threads = [threading.Thread(target=worker) for _ in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results.count(201) == 4 and results.count(409) == 8 and available("N-12") == 0 and available("N-13") == 36, {"results": results}


def invalid(path, body, raw=None):
    return lambda: error(*call("POST", path, body, raw=raw), 422, "invalid_request")


def main():
    start = ROOT / "start.sh"
    if not start.exists():
        print(json.dumps({"passed": 0, "total": 36, "results": [{"name": "start.sh exists", "passed": False}]}))
        return
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    log = open(ROOT.parent / f"{ROOT.name}-hidden-server.log", "w")
    proc = subprocess.Popen(["bash", "start.sh", str(PORT)], cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", PORT), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        check("create item", t_create)
        check("duplicate item conflict", t_duplicate)
        check("get item", t_get)
        check("unknown item 404", lambda: error(*call("GET", "/v1/items/NOPE"), 404, "not_found"))
        check("reserve shape and expiry", t_reserve_shape)
        check("reserve unknown sku 404", lambda: error(*reserve("NOPE", 1), 404, "not_found"))
        check("insufficient stock holds nothing", t_insufficient)
        check("release restores stock", t_release)
        check("confirm reduces quantity", t_confirm)
        check("confirm twice", t_confirm_twice)
        check("delete confirmed 404", t_delete_confirmed)
        check("unknown reservation delete 404", lambda: error(*call("DELETE", "/v1/reservations/nope"), 404, "not_found"))
        check("unknown reservation confirm 404", lambda: error(*call("POST", "/v1/reservations/nope/confirm", {}), 404, "not_found"))
        check("expiry frees stock and confirm 410", t_expiry)
        check("expired release 404", t_expired_release)
        check("expired capacity reusable", t_expired_capacity)
        check("idempotent repeat", t_idempotent)
        check("idempotency mismatch", t_idempotent_mismatch)
        check("distinct keys distinct reservations", t_distinct_keys)
        check("concurrent reservations never oversell", t_concurrent)
        check("concurrent same idempotency key", t_concurrent_idempotent)
        check("item sku invalid", invalid("/v1/items", {"sku": "bad sku!", "quantity": 1}))
        check("item sku too long", invalid("/v1/items", {"sku": "a" * 65, "quantity": 1}))
        check("item negative quantity", invalid("/v1/items", {"sku": "K-1", "quantity": -1}))
        check("item boolean quantity", invalid("/v1/items", {"sku": "K-2", "quantity": True}))
        check("item float quantity", invalid("/v1/items", {"sku": "K-3", "quantity": 1.5}))
        check("reserve zero quantity", invalid("/v1/reservations", {"sku": "A-1", "quantity": 0, "ttlSeconds": 10}))
        check("reserve ttl too large", invalid("/v1/reservations", {"sku": "A-1", "quantity": 1, "ttlSeconds": 3601}))
        check("reserve ttl missing", invalid("/v1/reservations", {"sku": "A-1", "quantity": 1}))
        check("body not object", invalid("/v1/items", [1]))
        check("malformed json", lambda: error(*call("POST", "/v1/items", raw=b"{nope"), 400, "invalid_json"))
        check("wrong content type", lambda: error(*call("POST", "/v1/items", {"sku": "L-1", "quantity": 1}, headers={"Content-Type": "text/plain"}), 415, "unsupported_media_type"))
        check("content type params", lambda: (lambda s, b: (s == 201, {"status": s, "body": b}))(*call("POST", "/v1/items", {"sku": "L-2", "quantity": 1}, headers={"Content-Type": "Application/JSON; charset=utf-8"})))
        check("unknown path 404", lambda: error(*call("GET", "/v1/nothing"), 404, "not_found"))
        check("wrong method 405", lambda: error(*call("PUT", "/v1/items", {"sku": "M", "quantity": 1}), 405, "method_not_allowed"))
        check("wrong method on reservation 405", lambda: error(*call("GET", "/v1/reservations"), 405, "method_not_allowed"))
        check("ext: sku with other symbol", invalid("/v1/items", {"sku": "bad>sku", "quantity": 1}))
        check("ext: content type suffix", lambda: error(*call("POST", "/v1/items", {"sku": "X-4", "quantity": 1}, headers={"Content-Type": "application/jsonx"}), 415, "unsupported_media_type"))
        check("ext: extra path segment 404", lambda: error(*call("GET", "/v1/items/A-1/extra"), 404, "not_found"))
        check("ext: wrong method on confirm 405", lambda: error(*call("DELETE", "/v1/reservations/abc/confirm"), 405, "method_not_allowed"))
        check("ext: malformed escape stays json", lambda: (lambda s, b: (s in (400, 404) and isinstance(b, dict) and isinstance(b.get("error"), dict), {"status": s, "body": b}))(*call("GET", "/v1/items/%")))
        check("ext: reconfirm after expiry 409", t_ext_reconfirm_after_expiry)
        check("ext: released then expired 404", t_ext_released_after_expiry)
        check("ext: idempotency key with different ttl", t_ext_idempotency_ttl)
        check("new: bundle response and holds", t_new_bundle_shape)
        check("new: bundle all or nothing on stock", t_new_all_or_nothing_stock)
        check("new: bundle all or nothing on unknown sku", t_new_all_or_nothing_unknown)
        check("new: confirm bundle", t_new_confirm_bundle)
        check("new: release bundle", t_new_release_bundle)
        check("new: get reservation states", t_new_get_states)
        check("new: bundle idempotency", t_new_bundle_idempotent)
        check("new: concurrent bundles never oversell", t_new_concurrent_bundles)
        check("new: both shapes 422", invalid("/v1/reservations", {"sku": "N-1", "quantity": 1, "lines": [{"sku": "N-2", "quantity": 1}], "ttlSeconds": 5}))
        check("new: empty lines 422", invalid("/v1/reservations", {"lines": [], "ttlSeconds": 5}))
        check("new: repeated sku 422", invalid("/v1/reservations", {"lines": [{"sku": "N-1", "quantity": 1}, {"sku": "N-1", "quantity": 2}], "ttlSeconds": 5}))
        check("new: too many lines 422", invalid("/v1/reservations", {"lines": [{"sku": f"Z-{i}", "quantity": 1} for i in range(21)], "ttlSeconds": 5}))
        check("new: invalid line 422", invalid("/v1/reservations", {"lines": [{"sku": "N-1", "quantity": 0}], "ttlSeconds": 5}))
        check("new: bundle missing ttl 422", invalid("/v1/reservations", {"lines": [{"sku": "N-1", "quantity": 1}]}))
        check("new: unknown reservation 404", lambda: error(*call("GET", "/v1/reservations/does-not-exist"), 404, "not_found"))
        check("new: wrong method on reservation id 405", lambda: error(*call("PUT", "/v1/reservations/abc", {}), 405, "method_not_allowed"))
    finally:
        os.killpg(proc.pid, 15)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, 9)
    passed = sum(1 for r in RESULTS if r["passed"])
    print(json.dumps({"passed": passed, "total": len(RESULTS), "results": RESULTS}, indent=1))


main()
