"""Hidden tests for the two-session conventions task. Usage: hidden_test.py <project_dir> [--stage 1|2]

Groups (the check-name prefix):
- core    the original contract and the first session's change (items list, audit log)
- new     the second request's behavior, independent of the conventions' names and shapes
- code    conventions C1 and C2 applied to the second request; the first session's code shows them
- memory  conventions C3 and C4 applied to the second request; only the first session's
          conversation states them

Stage 1 runs core only, on the project the first session left. Each group gets its own server so
list sizes and audit sequences do not depend on the other groups.
"""
import http.client
import json
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

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


def page(path):
    """The first session's list envelope: {"data": [...], "nextCursor": ...}."""
    status, body = call("GET", path)
    ok = status == 200 and isinstance(body, dict) and isinstance(body.get("data"), list) and "nextCursor" in body
    return ok, status, body


def walk(path, limit):
    """Follow cursors to the end; returns every row, or None if the envelope breaks."""
    rows, cursor = [], None
    for _ in range(100):
        sep = "&" if "?" in path else "?"
        # The cursor goes back as issued; only characters that would change the query are escaped,
        # so hand-written query parsing that does not percent-decode still pages.
        url = f"{path}{sep}limit={limit}" + (f"&cursor={quote(cursor, safe='=/:-_.~')}" if cursor else "")
        ok, _, body = page(url)
        if not ok or len(body["data"]) > limit:
            return None
        rows += body["data"]
        cursor = body["nextCursor"]
        if cursor is None:
            return rows
        if not isinstance(cursor, str):
            return None
    return None


def rows_of(body):
    """List rows in any envelope: a bare list, or the first list-valued field."""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for value in body.values():
            if isinstance(value, list):
                return value
    return None


def audit():
    return walk("/v1/audit", 100) or []


def audit_for(target):
    return [entry for entry in audit() if isinstance(entry, dict) and entry.get("target") == target]


def price_key(sku):
    """The project's own name for an item's price, whatever the conventions say."""
    _, body = call("GET", f"/v1/items/{sku}")
    keys = [k for k in body if "price" in k.lower()] if isinstance(body, dict) else []
    return keys[0] if len(keys) == 1 else None


# --- core: original contract and the first session's change -------------------------------


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

    # First session: items list (C1).
    def items_list():
        skus = [f"L-{i:02d}" for i in range(25)]
        for sku in skus:
            item(sku, 1)
        rows = walk("/v1/items", 7)
        listed = [row.get("sku") for row in rows or [] if isinstance(row, dict)]
        return (listed == ["A-1", "B-1", "B-2", "B-3"] + skus), listed
    check("items list pages through every item in creation order", items_list)
    check("items list default page is 20 with a cursor", lambda: (
        lambda r: (r[0] and len(r[2]["data"]) == 20 and isinstance(r[2]["nextCursor"], str), r[1:])
    )(page("/v1/items")))
    check("items list rows have sku, quantity and available", lambda: (
        lambda r: (r[0] and all(isinstance(x, dict) and {"sku", "quantity", "available"} <= set(x)
                                for x in r[2]["data"]), r[2])
    )(page("/v1/items?limit=3")))
    check("last page has null nextCursor", lambda: (
        lambda r: (r[0] and r[2]["nextCursor"] is None, r[2])
    )(page("/v1/items?limit=100")))
    for bad in ("0", "101", "abc", "-1"):
        check(f"items list limit={bad} is 422", lambda bad=bad: error(call("GET", f"/v1/items?limit={bad}"), 422, "invalid_request"))
    check("items list unknown cursor is 422", lambda: error(call("GET", "/v1/items?cursor=no-such-cursor"), 422, "invalid_request"))

    # First session: audit log (C2).
    def audit_existing():
        item("AU-1", 5)
        created = reserve("AU-1", 1, key="au-key")[1]
        reserve("AU-1", 1, key="au-key")  # replay: no entry
        reserve("AU-1", 99)  # error: no entry
        call("POST", f"/v1/reservations/{created['id']}/confirm", {})
        other = reserve("AU-1", 1)[1]
        call("DELETE", f"/v1/reservations/{other['id']}")
        mine = [(e.get("action"), e.get("target")) for e in audit()
                if isinstance(e, dict) and e.get("target") in ("AU-1", created["id"], other["id"])]
        expected = [("item.create", "AU-1"), ("reservation.create", created["id"]),
                    ("reservation.confirm", created["id"]), ("reservation.create", other["id"]),
                    ("reservation.release", other["id"])]
        return mine == expected, mine
    check("audit records existing changes, not replays or errors", audit_existing)
    check("audit seq counts from 1 without gaps", lambda: (
        lambda entries: (bool(entries) and [e.get("seq") for e in entries] == list(range(1, len(entries) + 1)), entries[:5])
    )(audit()))
    check("audit is paginated", lambda: (
        lambda r: (r[0] and len(r[2]["data"]) == 2 and isinstance(r[2]["nextCursor"], str), r[2])
    )(page("/v1/audit?limit=2")))


# --- new: the second request, independent of the conventions -------------------------------


def new():
    item("P-1", 10)
    detected = price_key("P-1")
    check("items have exactly one price field", lambda: (detected is not None, call("GET", "/v1/items/P-1")))
    key = detected or "price"
    check("price defaults to 0", lambda: (call("GET", "/v1/items/P-1")[1].get(key) == 0, call("GET", "/v1/items/P-1")))
    check("price set on create", lambda: (
        lambda r: (r[0] == 201 and r[1].get(key) == 250, r))(item("P-2", 5, **{key: 250})))
    check("PUT price returns the item with the new price", lambda: (
        lambda r: (r[0] == 200 and isinstance(r[1], dict) and r[1].get("sku") == "P-1" and r[1].get(key) == 125, r)
    )(call("PUT", "/v1/items/P-1/price", {key: 125})))
    check("price appears in reads and lists", lambda: (
        lambda one, rows: (one.get(key) == 125 and any(isinstance(x, dict) and x.get("sku") == "P-1" and x.get(key) == 125
                                                      for x in rows_of(rows) or []), [one, rows])
    )(call("GET", "/v1/items/P-1")[1], call("GET", "/v1/items?limit=100")[1]))
    check("negative price is 422", lambda: error(call("PUT", "/v1/items/P-1/price", {key: -1}), 422, "invalid_request"))
    check("PUT price on unknown item is 404", lambda: error(call("PUT", "/v1/items/NOPE/price", {key: 1}), 404, "not_found"))

    def total():
        reservation = reserve("P-1", 3)[1]
        first = call("GET", f"/v1/reservations/{reservation['id']}/total")
        call("PUT", "/v1/items/P-1/price", {key: 200})
        second = call("GET", f"/v1/reservations/{reservation['id']}/total")
        values = lambda body: [v for k, v in body.items() if k != "id"] if isinstance(body, dict) else []
        return (first[0] == 200 and first[1].get("id") == reservation["id"] and 375 in values(first[1])
                and second[0] == 200 and 600 in values(second[1])), [first, second]
    check("total is quantity times the current price", total)
    check("total for unknown reservation is 404", lambda: error(call("GET", "/v1/reservations/nope/total"), 404, "not_found"))

    item("R-1", 3)
    held = reserve("R-1", 1)[1]
    check("retiring an item with an active reservation is 409", lambda: error(call("DELETE", "/v1/items/R-1"), 409, "conflict"))
    call("DELETE", f"/v1/reservations/{held['id']}")
    check("retiring an item is 204", lambda: (lambda r: (r[0] == 204, r))(call("DELETE", "/v1/items/R-1")))
    check("retiring an unknown item is 404", lambda: error(call("DELETE", "/v1/items/NOPE"), 404, "not_found"))
    check("a retired item is no longer readable", lambda: (lambda r: (r[0] in (404, 410), r))(call("GET", "/v1/items/R-1")))

    item("S-1", 10)
    ids = {}
    ids["active"] = reserve("S-1", 1)[1]["id"]
    ids["confirmed"] = reserve("S-1", 1)[1]["id"]
    call("POST", f"/v1/reservations/{ids['confirmed']}/confirm", {})
    ids["released"] = reserve("S-1", 1)[1]["id"]
    call("DELETE", f"/v1/reservations/{ids['released']}")
    ids["expired"] = reserve("S-1", 1, ttl=1)[1]["id"]
    time.sleep(1.5)

    def listed(query=""):
        return rows_of(call("GET", f"/v1/reservations?limit=100{query}")[1]) or []

    def by_id(rows):
        return {row.get("id"): row for row in rows if isinstance(row, dict)}
    check("reservations list shows each with its status", lambda: (
        lambda rows: (all(rows.get(i, {}).get("status") == s for s, i in ids.items()), rows)
    )(by_id(listed())))
    check("reservations list rows have the listed fields", lambda: (
        lambda rows: (bool(rows) and all({"id", "sku", "quantity", "status", "expiresAt"} <= set(r) for r in rows), rows[:2])
    )(listed()))
    for status in ("active", "confirmed", "released", "expired"):
        check(f"status={status} filters", lambda status=status: (
            lambda rows: ([r.get("id") for r in rows if r.get("sku") == "S-1"] == [ids[status]]
                          and all(r.get("status") == status for r in rows), rows)
        )(listed(f"&status={status}")))
    check("unknown status is 422", lambda: error(call("GET", "/v1/reservations?status=pending"), 422, "invalid_request"))


# --- code: C1 and C2 on the second request (shown by the first session's code) -------------


def code():
    item("C-1", 30)
    ids = [reserve("C-1", 1)[1]["id"] for _ in range(23)]
    check("reservations list uses the data/nextCursor envelope", lambda: (
        lambda r: (r[0], r[1:]))(page("/v1/reservations")))
    check("reservations list default page is 20", lambda: (
        lambda r: (r[0] and len(r[2]["data"]) == 20 and isinstance(r[2]["nextCursor"], str), r[2])
    )(page("/v1/reservations")))
    check("reservations list pages in creation order", lambda: (
        lambda rows: (rows is not None and [r.get("id") for r in rows] == ids, rows and [r.get("id") for r in rows])
    )(walk("/v1/reservations", 6)))
    check("status filter pages too", lambda: (
        lambda rows: (rows is not None and [r.get("id") for r in rows] == ids, rows)
    )(walk("/v1/reservations?status=active", 5)))
    check("reservations list limit=0 is 422", lambda: error(call("GET", "/v1/reservations?limit=0"), 422, "invalid_request"))
    check("reservations list limit=101 is 422", lambda: error(call("GET", "/v1/reservations?limit=101"), 422, "invalid_request"))
    check("reservations list unknown cursor is 422", lambda: error(call("GET", "/v1/reservations?cursor=zzz"), 422, "invalid_request"))

    item("C-2", 1)
    key = price_key("C-2") or "priceCents"
    call("PUT", "/v1/items/C-2/price", {key: 10})
    check("setting a price is audited", lambda: (
        lambda entries: (len(entries) == 2 and entries[1].get("action", "").startswith("item.")
                         and entries[1].get("action") != "item.create", entries)
    )(audit_for("C-2")))
    held = reserve("C-2", 1)[1]
    call("DELETE", "/v1/items/C-2")  # 409: nothing changes
    call("PUT", "/v1/items/C-2/price", {key: -5})  # 422: nothing changes
    call("DELETE", f"/v1/reservations/{held['id']}")
    call("DELETE", "/v1/items/C-2")
    check("retiring is audited once; refused requests are not", lambda: (
        lambda entries: (len(entries) == 3 and entries[2].get("action", "").startswith("item.")
                         and entries[2].get("action") not in (entries[0].get("action"), entries[1].get("action")), entries)
    )(audit_for("C-2")))


# --- memory: C3 and C4 on the second request (only the first conversation states them) ------


def memory():
    item("M-0", 1)
    detected = price_key("M-0")
    key = detected if detected and detected.endswith("Cents") else "priceCents"
    check("the price field is an integer field ending in Cents", lambda: (
        lambda body: (detected is not None and detected.endswith("Cents") and type(body.get(detected)) is int, body)
    )(call("GET", "/v1/items/M-0")[1]))
    check("create accepts the Cents price field", lambda: (
        lambda r: (r[0] == 201 and r[1].get(key) == 250, r))(item("M-1", 5, **{key: 250})))

    def put_cents():
        taken = call("PUT", "/v1/items/M-1/price", {key: 99})
        fraction = call("PUT", "/v1/items/M-1/price", {key: 9.5})
        text = call("PUT", "/v1/items/M-1/price", {key: "99"})
        ok = (taken[0] == 200 and taken[1].get(key) == 99
              and error(fraction, 422, "invalid_request")[0] and error(text, 422, "invalid_request")[0])
        return ok, [taken, fraction, text]
    check("PUT price takes integer cents only", put_cents)

    def total():
        reservation = reserve("M-1", 2)[1]
        status, body = call("GET", f"/v1/reservations/{reservation['id']}/total")
        money = {k: v for k, v in body.items() if k != "id"} if isinstance(body, dict) else {}
        ok = (status == 200 and len(money) == 1 and next(iter(money)).endswith("Cents")
              and next(iter(money.values())) == 198 and type(next(iter(money.values()))) is int)
        return ok, [status, body]
    check("total is one integer field ending in Cents", total)

    item("M-2", 1)
    call("DELETE", "/v1/items/M-2")
    check("retired item read is 410 gone", lambda: error(call("GET", "/v1/items/M-2"), 410, "gone"))
    check("retiring again is 410 gone", lambda: error(call("DELETE", "/v1/items/M-2"), 410, "gone"))
    check("PUT price on a retired item is 410 gone", lambda: error(call("PUT", "/v1/items/M-2/price", {key: 1}), 410, "gone"))
    check("items list omits retired items, which still answer 410", lambda: (
        lambda rows, read: (rows is not None and "M-2" not in [r.get("sku") for r in rows]
                            and "M-1" in [r.get("sku") for r in rows] and read[0] == 410,
                            [rows and [r.get("sku") for r in rows], read])
    )(walk("/v1/items", 100), call("GET", "/v1/items/M-2")))


GROUPS = [("core", core)] if STAGE == 1 else [("core", core), ("new", new), ("code", code), ("memory", memory)]
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
