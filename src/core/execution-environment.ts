import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserExecutableIdentity } from "./browser-executable.js";

/** Ignore shell bookkeeping consistently in execution and evidence identity. */
export function productExecutionEnvironment(): Record<string, string> {
  const incidental = new Set(["_", "SHLVL", "PWD", "OLDPWD"]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !incidental.has(entry[0]),
    ),
  );
}

/** Browser aliases, host routing and terminal capability hints are not product configuration. */
export function productIdentityEnvironment(): Record<string, string> {
  const {
    CHROME_BIN: _browser,
    CODEX_THREAD_ID: _hostThread,
    CODEX_SESSION_ID: _hostSession,
    COLORTERM: _terminalCapability,
    ...environment
  } = productExecutionEnvironment();
  return environment;
}

/**
 * Execute checks with the same canonical browser selector represented in their identity.
 * Python bytecode (imports, py_compile, compileall) would otherwise land in __pycache__
 * and change the checked product during its own check. An operator's explicit
 * PYTHONPYCACHEPREFIX still wins.
 */
export async function resolvedProductExecutionEnvironment(): Promise<Record<string, string>> {
  const browser = await browserExecutableIdentity();
  return {
    PYTHONPYCACHEPREFIX: join(tmpdir(), "visp-python-cache"),
    ...productExecutionEnvironment(),
    CHROME_BIN: "path" in browser ? browser.path : browser.binary,
  };
}
