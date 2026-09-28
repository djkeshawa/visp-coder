"""Hidden checks for slingshot-game: serves the project and drives it in Chrome.

Usage: hidden_test.py <project>
Prints {"results": [{"name", "passed", "detail"}]}. Needs Node.js, Google Chrome (CHROME_BIN or
google-chrome on PATH) and playwright-core (PLAYWRIGHT_CORE, or found in the npx cache).
"""
import functools
import glob
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading

HERE = pathlib.Path(__file__).resolve().parent
project = pathlib.Path(sys.argv[1]).resolve()


def playwright_core():
    if os.environ.get("PLAYWRIGHT_CORE"):
        return os.environ["PLAYWRIGHT_CORE"]
    found = sorted(glob.glob(str(pathlib.Path.home() / ".npm/_npx/*/node_modules/playwright-core")))
    return found[-1] if found else ""


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


handler = functools.partial(Quiet, directory=str(project))
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    if not (project / "index.html").is_file():
        print(json.dumps({"results": [{"name": "index.html exists", "passed": False, "detail": "missing"}]}))
        sys.exit(0)
    env = {
        **os.environ,
        "GAME_URL": f"http://127.0.0.1:{server.server_address[1]}/index.html",
        "PLAYWRIGHT_CORE": playwright_core(),
        "CHROME_BIN": os.environ.get("CHROME_BIN") or shutil.which("google-chrome") or "",
    }
    out = subprocess.run(["node", str(HERE / "hidden_game.mjs")], env=env, capture_output=True,
                         text=True, timeout=540)
    try:
        json.loads(out.stdout)
        print(out.stdout)
    except ValueError:
        print(json.dumps({"results": [{"name": "harness", "passed": False,
                                       "detail": (out.stderr or out.stdout)[-800:]}]}))
finally:
    server.shutdown()
