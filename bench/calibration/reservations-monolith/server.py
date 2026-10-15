import json, re, sys, threading, uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

L = threading.Lock()
d1 = {}
d2 = {}
d3 = {}


def x(s, m):
    p = s.path.rstrip("/")
    q = p.split("/")
    st = 404
    r = {"error": {"code": "not_found", "message": "not found"}}
    if p == "/v1/items":
        if m != "POST":
            st = 405
            r = {"error": {"code": "method_not_allowed", "message": "method not allowed"}}
        else:
            raw = s.rfile.read(int(s.headers.get("Content-Length") or 0))
            if s.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                st = 415
                r = {"error": {"code": "unsupported_media_type", "message": "unsupported media type"}}
            else:
                try:
                    b = json.loads(raw)
                    ok = True
                except ValueError:
                    ok = False
                    st = 400
                    r = {"error": {"code": "invalid_json", "message": "invalid json"}}
                if ok:
                    if not isinstance(b, dict):
                        st = 422
                        r = {"error": {"code": "invalid_request", "message": "invalid request"}}
                    else:
                        a = b.get("sku")
                        c = b.get("quantity")
                        if not isinstance(a, str) or not re.match(r"^[A-Za-z0-9-]{1,64}$", a) or not isinstance(c, int) or isinstance(c, bool) or c < 0:
                            st = 422
                            r = {"error": {"code": "invalid_request", "message": "invalid request"}}
                        else:
                            with L:
                                if a in d1:
                                    st = 409
                                    r = {"error": {"code": "conflict", "message": "conflict"}}
                                else:
                                    d1[a] = c
                                    t = 0
                                    for k in d2:
                                        if d2[k]["sku"] == a and d2[k]["state"] == "active" and d2[k]["expires"] > datetime.now(timezone.utc):
                                            t = t + d2[k]["quantity"]
                                    st = 201
                                    r = {"sku": a, "quantity": d1[a], "available": d1[a] - t}
    elif len(q) == 4 and q[1] == "v1" and q[2] == "items":
        if m != "GET":
            st = 405
            r = {"error": {"code": "method_not_allowed", "message": "method not allowed"}}
        else:
            with L:
                if q[3] not in d1:
                    st = 404
                    r = {"error": {"code": "not_found", "message": "not found"}}
                else:
                    t = 0
                    for k in d2:
                        if d2[k]["sku"] == q[3] and d2[k]["state"] == "active" and d2[k]["expires"] > datetime.now(timezone.utc):
                            t = t + d2[k]["quantity"]
                    st = 200
                    r = {"sku": q[3], "quantity": d1[q[3]], "available": d1[q[3]] - t}
    elif p == "/v1/reservations":
        if m != "POST":
            st = 405
            r = {"error": {"code": "method_not_allowed", "message": "method not allowed"}}
        else:
            raw = s.rfile.read(int(s.headers.get("Content-Length") or 0))
            if s.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                st = 415
                r = {"error": {"code": "unsupported_media_type", "message": "unsupported media type"}}
            else:
                try:
                    b = json.loads(raw)
                    ok = True
                except ValueError:
                    ok = False
                    st = 400
                    r = {"error": {"code": "invalid_json", "message": "invalid json"}}
                if ok:
                    if not isinstance(b, dict):
                        st = 422
                        r = {"error": {"code": "invalid_request", "message": "invalid request"}}
                    else:
                        a = b.get("sku")
                        c = b.get("quantity")
                        e = b.get("ttlSeconds")
                        if not isinstance(a, str) or not isinstance(c, int) or isinstance(c, bool) or c < 1 or not isinstance(e, int) or isinstance(e, bool) or e < 1 or e > 3600:
                            st = 422
                            r = {"error": {"code": "invalid_request", "message": "invalid request"}}
                        else:
                            k2 = s.headers.get("Idempotency-Key")
                            z = json.dumps(b, sort_keys=True)
                            with L:
                                if k2 and k2 in d3:
                                    if d3[k2][0] != z:
                                        st = 422
                                        r = {"error": {"code": "idempotency_mismatch", "message": "idempotency mismatch"}}
                                    else:
                                        st = 201
                                        r = d3[k2][1]
                                elif a not in d1:
                                    st = 404
                                    r = {"error": {"code": "not_found", "message": "not found"}}
                                else:
                                    t = 0
                                    for k in d2:
                                        if d2[k]["sku"] == a and d2[k]["state"] == "active" and d2[k]["expires"] > datetime.now(timezone.utc):
                                            t = t + d2[k]["quantity"]
                                    if d1[a] - t < c:
                                        st = 409
                                        r = {"error": {"code": "insufficient_stock", "message": "insufficient stock"}}
                                    else:
                                        i = uuid.uuid4().hex
                                        ex = datetime.now(timezone.utc) + timedelta(seconds=e)
                                        d2[i] = {"sku": a, "quantity": c, "expires": ex, "state": "active"}
                                        st = 201
                                        r = {"id": i, "sku": a, "quantity": c, "expiresAt": ex.isoformat().replace("+00:00", "Z")}
                                        if k2:
                                            d3[k2] = (z, r)
    elif len(q) == 4 and q[1] == "v1" and q[2] == "reservations":
        if m != "DELETE":
            st = 405
            r = {"error": {"code": "method_not_allowed", "message": "method not allowed"}}
        else:
            with L:
                v = d2.get(q[3])
                if not v or v["state"] != "active" or v["expires"] <= datetime.now(timezone.utc):
                    st = 404
                    r = {"error": {"code": "not_found", "message": "not found"}}
                else:
                    v["state"] = "released"
                    st = 204
                    r = None
    elif len(q) == 5 and q[1] == "v1" and q[2] == "reservations" and q[4] == "confirm":
        if m != "POST":
            st = 405
            r = {"error": {"code": "method_not_allowed", "message": "method not allowed"}}
        else:
            with L:
                v = d2.get(q[3])
                if not v or v["state"] == "released":
                    st = 404
                    r = {"error": {"code": "not_found", "message": "not found"}}
                elif v["state"] == "confirmed":
                    st = 409
                    r = {"error": {"code": "already_confirmed", "message": "already confirmed"}}
                elif v["expires"] <= datetime.now(timezone.utc):
                    st = 410
                    r = {"error": {"code": "expired", "message": "expired"}}
                else:
                    v["state"] = "confirmed"
                    d1[v["sku"]] = d1[v["sku"]] - v["quantity"]
                    st = 200
                    r = {"id": q[3], "status": "confirmed"}
    o = b"" if r is None else json.dumps(r).encode()
    s.send_response(st)
    if r is not None:
        s.send_header("Content-Type", "application/json")
    s.send_header("Content-Length", str(len(o)))
    s.end_headers()
    s.wfile.write(o)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        x(self, "GET")

    def do_POST(self):
        x(self, "POST")

    def do_PUT(self):
        x(self, "PUT")

    def do_DELETE(self):
        x(self, "DELETE")


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
