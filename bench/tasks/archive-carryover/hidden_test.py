"""Hidden tests for archive carryover. Usage: hidden_test.py <project_dir> [--stage 1|2]

core: original contract and session 1 archiving/cap.
new: session 2 behavior independent of the carried decisions.
memory: session 1 decisions applied to session 2 paths.
Each group gets a fresh server; stage 1 runs core only.
"""
import http.client
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
STAGE = int(sys.argv[sys.argv.index("--stage") + 1]) if "--stage" in sys.argv else 2
RESULTS = []
PORT = None


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server():
    global PORT
    PORT = free_port()
    proc = subprocess.Popen(["sh", str(ROOT / "start.sh"), str(PORT)], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close()
            return proc
        except OSError:
            time.sleep(0.1)
    return proc


def stop_server(proc):
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()


def call(method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=5)
    data = json.dumps(body).encode() if body is not None else None
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


def error(response, expected, code):
    status, body = response
    ok = (
        status == expected
        and isinstance(body, dict)
        and isinstance(body.get("error"), dict)
        and body["error"].get("code") == code
        and isinstance(body["error"].get("message"), str)
        and body["error"]["message"].strip() != ""
    )
    return ok, {"status": status, "body": body}


def item(sku, quantity, **extra):
    return call("POST", "/v1/items", {"sku": sku, "quantity": quantity, **extra})


def reserve(sku, quantity, ttl=60, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    return call("POST", "/v1/reservations", {"sku": sku, "quantity": quantity, "ttlSeconds": ttl}, headers)



def read(sku):
    return call("GET", f"/v1/items/{sku}")


def archive(sku):
    return call("POST", f"/v1/items/{sku}/archive")


def restock(sku, amount):
    return call("POST", f"/v1/items/{sku}/restock", {"amount": amount})


def bundle(lines, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    return call("POST", "/v1/reservations", {"lines": lines, "ttlSeconds": 60}, headers)


def line(sku, quantity=1):
    return {"sku": sku, "quantity": quantity}


def core():
    check("item create and read", lambda: (
        lambda created, read: (created[0] == 201 and read[0] == 200 and isinstance(read[1], dict)
                               and {k: read[1].get(k) for k in ("sku", "quantity", "available")}
                               == {"sku": "A-1", "quantity": 5, "available": 5}, [created, read])
    )(item("A-1", 5), call("GET", "/v1/items/A-1")))
    check("duplicate item is 409 conflict", lambda: error(item("A-1", 1), 409, "conflict"))
    check("invalid item is 422", lambda: error(item("bad sku!", 1), 422, "invalid_request"))
    check("unknown item is 404", lambda: error(call("GET", "/v1/items/NOPE"), 404, "not_found"))
    check("415 for non-JSON body", lambda: error(
        call("POST", "/v1/items", {"sku": "X", "quantity": 1}, {"Content-Type": "text/plain"}),
        415, "unsupported_media_type"))

    def reserve_confirm_release():
        item("B-1", 5)
        status, body = reserve("B-1", 2)
        after_reserve = call("GET", "/v1/items/B-1")[1]
        confirmed = call("POST", f"/v1/reservations/{body['id']}/confirm", {})
        after_confirm = call("GET", "/v1/items/B-1")[1]
        again = call("POST", f"/v1/reservations/{body['id']}/confirm", {})
        other = reserve("B-1", 1)[1]
        released = call("DELETE", f"/v1/reservations/{other['id']}")
        ok = (status == 201 and after_reserve["available"] == 3 and confirmed[0] == 200
              and after_confirm["quantity"] == 3 and after_confirm["available"] == 3
              and error(again, 409, "already_confirmed")[0] and released[0] == 204)
        return ok, [status, after_reserve, confirmed, after_confirm, again, released]
    check("reserve, confirm and release", reserve_confirm_release)
    check("insufficient stock is 409", lambda: (item("B-2", 1), error(reserve("B-2", 2), 409, "insufficient_stock"))[1])

    def idempotent():
        item("B-3", 5)
        first = reserve("B-3", 2, key="k-1")
        replay = reserve("B-3", 2, key="k-1")
        mismatch = reserve("B-3", 3, key="k-1")
        avail = call("GET", "/v1/items/B-3")[1]["available"]
        return (first[0] == 201 and replay == first and error(mismatch, 422, "idempotency_mismatch")[0]
                and avail == 3), [first, replay, mismatch, avail]
    check("idempotency key replays without holding again", idempotent)

    def default_flag():
        created = item("AR-0", 4)
        fetched = read("AR-0")
        return (created[0] == 201 and fetched[0] == 200
                and created[1].get("archived") is False
                and fetched[1].get("archived") is False), [created, fetched]
    check("items default to archived false on create and read", default_flag)

    def archive_twice():
        item("AR-1", 4)
        first, second, fetched = archive("AR-1"), archive("AR-1"), read("AR-1")
        expected = {"sku": "AR-1", "quantity": 4, "available": 4, "archived": True}
        return all(r == (200, expected) for r in (first, second, fetched)), [first, second, fetched]
    check("archive returns the item, persists and is repeatable", archive_twice)
    check("archive unknown is 404", lambda: error(archive("NOPE"), 404, "not_found"))

    def archived_reservation():
        item("AR-2", 5)
        archive("AR-2")
        before = read("AR-2")
        refused = reserve("AR-2", 2)
        after = read("AR-2")
        return error(refused, 409, "item_archived")[0] and before == after, [refused, before, after]
    check("archived single reservation is refused without holding", archived_reservation)

    def existing_reservations():
        item("AR-3", 7)
        first, second = reserve("AR-3", 2)[1], reserve("AR-3", 1)[1]
        archived = archive("AR-3")
        confirmed = call("POST", f"/v1/reservations/{first['id']}/confirm", {})
        released = call("DELETE", f"/v1/reservations/{second['id']}")
        fetched = read("AR-3")
        return (archived[0] == 200 and archived[1].get("available") == 4
                and confirmed[0] == 200 and released[0] == 204
                and fetched == (200, {"sku": "AR-3", "quantity": 5, "available": 5, "archived": True})), [archived, confirmed, released, fetched]
    check("archiving preserves existing holds, confirmation and release", existing_reservations)

    def cap_rejected():
        rejected = item("CAP-1", 10001)
        absent = read("CAP-1")
        return (error(rejected, 422, "invalid_request")[0]
                and error(absent, 404, "not_found")[0]), [rejected, absent]
    check("create above 10000 is rejected without creating an item", cap_rejected)
    check("create exactly 10000 succeeds", lambda: (
        lambda r: (r == (201, {"sku": "CAP-2", "quantity": 10000, "available": 10000, "archived": False}), r)
    )(item("CAP-2", 10000)))


def new():
    def success():
        item("N-B", 8)
        item("N-A", 9)
        lines = [line("N-B", 2), line("N-A", 3)]
        result = bundle(lines)
        b, a = read("N-B"), read("N-A")
        body = result[1]
        from datetime import datetime, timezone
        expires = datetime.fromisoformat(body["expiresAt"].replace("Z", "+00:00"))
        return (result[0] == 201 and set(body) == {"id", "lines", "expiresAt"}
                and isinstance(body["id"], str) and bool(body["id"])
                and body["lines"] == lines and expires.utcoffset().total_seconds() == 0
                and expires > datetime.now(timezone.utc)
                and b[1]["available"] == 6 and a[1]["available"] == 6), [result, b, a]
    check("bundle success preserves request order and holds each line", success)

    def refusal(sku, stock, expected, code):
        item(sku, stock)
        before = read(sku)
        lines = [line(sku), line("MISSING")] if expected == 404 else [line(sku), line("N-B", 99)]
        other_before = read("N-B")
        result = bundle(lines)
        after, other_after = read(sku), read("N-B")
        return (error(result, expected, code)[0] and before == after
                and other_before == other_after), [result, before, after, other_before, other_after]
    check("unknown bundle line is 404 and holds nothing", lambda: refusal("N-404", 5, 404, "not_found"))
    check("insufficient bundle line is 409 and holds nothing", lambda: refusal("N-409", 5, 409, "insufficient_stock"))

    def invalid_bodies(bodies):
        before = read("N-A")
        responses = [call("POST", "/v1/reservations", body) for body in bodies]
        after = read("N-A")
        return (all(error(r, 422, "invalid_request")[0] for r in responses)
                and before == after), [responses, before, after]
    check("bundle both shapes or neither is 422", lambda: invalid_bodies([
        {"lines": [line("N-A")], "sku": "N-A", "quantity": 1, "ttlSeconds": 60},
        {"lines": [line("N-A")], "quantity": 1, "ttlSeconds": 60},
        {"ttlSeconds": 60}]))
    check("bundle empty, oversized or non-list lines is 422", lambda: invalid_bodies([
        {"lines": lines, "ttlSeconds": 60} for lines in ([], [line(f"L-{i}") for i in range(21)], {}, None)]))
    check("bundle repeated SKU is 422", lambda: invalid_bodies([
        {"lines": [line("N-A"), line("N-A", 2)], "ttlSeconds": 60}]))
    check("bundle invalid line is 422", lambda: invalid_bodies([
        {"lines": [line("N-A"), bad], "ttlSeconds": 60}
        for bad in (None, {}, {"sku": 12, "quantity": 1}, {"sku": "N-B"},
                    line("N-B", 0), line("N-B", -1), line("N-B", True), line("N-B", 1.5), line("N-B", "1"))]))
    check("bundle invalid ttl is 422", lambda: invalid_bodies([
        {"lines": [line("N-A")], "ttlSeconds": ttl} for ttl in (None, 0, 3601, True, 1.5, "60")]))

    def maximum_lines():
        lines = [line(f"TW-{i}") for i in range(20)]
        for entry in lines:
            item(entry["sku"], 1)
        result = bundle(lines)
        return result[0] == 201 and result[1].get("lines") == lines, result
    check("20-line bundle succeeds", maximum_lines)

    def idempotency():
        item("N-ID", 5)
        first = bundle([line("N-ID", 2)], "bundle-key")
        replay = bundle([line("N-ID", 2)], "bundle-key")
        mismatch = bundle([line("N-ID", 3)], "bundle-key")
        shape_mismatch = reserve("N-ID", 2, key="bundle-key")
        fetched = read("N-ID")
        return (first[0] == 201 and first == replay
                and error(mismatch, 422, "idempotency_mismatch")[0]
                and error(shape_mismatch, 422, "idempotency_mismatch")[0]
                and fetched[1]["available"] == 3), [first, replay, mismatch, shape_mismatch, fetched]
    check("bundle idempotency replays and rejects changed body or shape", idempotency)

    def failed_key():
        lines = [line("N-LATER")]
        first = bundle(lines, "retry-key")
        item("N-LATER", 2)
        retry = bundle(lines, "retry-key")
        return error(first, 404, "not_found")[0] and retry[0] == 201, [first, retry]
    check("failed bundle does not consume idempotency key", failed_key)

    def restock_success():
        item("N-R", 5)
        reserve("N-R", 2)
        result = restock("N-R", 3)
        fetched = read("N-R")
        expected = {"sku": "N-R", "quantity": 8, "available": 6}
        return (result[0] == 200 and result == fetched
                and all(result[1].get(k) == v for k, v in expected.items())), [result, fetched]
    check("restock returns and persists quantity with existing holds", restock_success)
    check("restock unknown is 404", lambda: error(restock("NOPE", 1), 404, "not_found"))

    def invalid_restock():
        item("N-BAD-R", 5)
        before = read("N-BAD-R")
        responses = [restock("N-BAD-R", value) for value in (0, -1, True, False, 1.5, "1", None)]
        responses.append(call("POST", "/v1/items/N-BAD-R/restock", {}))
        after = read("N-BAD-R")
        return (all(error(r, 422, "invalid_request")[0] for r in responses)
                and before == after), [responses, before, after]
    check("restock invalid or missing amount is 422 without changes", invalid_restock)
    check("restock wrong method is 405", lambda: error(call("GET", "/v1/items/N-R/restock"), 405, "method_not_allowed"))


def memory():
    # Each check uses independent items and contains a rejection assertion. Positive
    # boundary/control cases alone would pass the deliberately forgetful variant.
    def archived_bundle(label, position, unaffected=False):
        archived, healthy = f"{label}-AR", f"{label}-OK"
        item(archived, 8)
        item(healthy, 8)
        archive(archived)
        lines = [line(archived, 2)]
        if position == "first":
            lines.append(line(healthy, 3))
        elif position == "last":
            lines.insert(0, line(healthy, 3))
        before = [read(archived), read(healthy)]
        result = bundle(lines)
        after = [read(archived), read(healthy)]
        ok = error(result, 409, "item_archived")[0] and before == after
        details = [result, before, after]
        if unaffected:
            item(f"{label}-OTHER", 4)
            valid_lines = [line(healthy, 2), line(f"{label}-OTHER", 1)]
            valid = bundle(valid_lines)
            quantities = [read(healthy)[1]["available"], read(f"{label}-OTHER")[1]["available"]]
            ok = ok and valid[0] == 201 and valid[1].get("lines") == valid_lines and quantities == [6, 3]
            details.extend([valid, quantities])
        return ok, details
    check("one-line bundle refuses archived item and holds nothing", lambda: archived_bundle("M-1", "only"))
    check("archived first line rejects whole bundle with healthy line", lambda: archived_bundle("M-2", "first"))
    check("archived last line rejects whole bundle; healthy bundles still work", lambda: archived_bundle("M-3", "last", True))

    def capped_restock(sku, quantity, amount, held=0, boundary=False):
        item(sku, quantity)
        if held:
            reserve(sku, held)
        before = read(sku)
        rejected = restock(sku, amount)
        after = read(sku)
        ok = error(rejected, 422, "invalid_request")[0] and before == after
        details = [rejected, before, after]
        if boundary:
            accepted = restock(sku, 10000 - quantity)
            fetched = read(sku)
            expected = {"sku": sku, "quantity": 10000, "available": 10000 - held, "archived": False}
            ok = ok and accepted == (200, expected) and fetched == accepted
            details.extend([accepted, fetched])
        return ok, details
    check("restock above cap changes nothing; exactly 10000 succeeds", lambda: capped_restock("M-4", 9995, 6, boundary=True))
    check("restock at cap rejects one extra unit without changes", lambda: capped_restock("M-5", 10000, 1))
    check("restock cap uses quantity, not available stock", lambda: capped_restock("M-6", 9998, 3, held=10))


GROUPS = [("core", core)] if STAGE == 1 else [("core", core), ("new", new), ("memory", memory)]
for prefix, run_group in GROUPS:
    server = start_server()
    before = len(RESULTS)
    try:
        run_group()
    finally:
        stop_server(server)
    if prefix != "core":
        for result in RESULTS[before:]:
            result["name"] = f"{prefix}:{result['name']}"

print(json.dumps({"passed": sum(r["passed"] for r in RESULTS), "total": len(RESULTS), "results": RESULTS}, indent=2))
