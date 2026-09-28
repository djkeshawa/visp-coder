import { browserExecutableIdentity } from "./browser-executable.js";
import { pythonCacheDirectory } from "./python-cache.js";

/** Ignore shell bookkeeping consistently in execution and evidence identity. */
export function productExecutionEnvironment(): Record<string, string> {
  const incidental = new Set(["_", "SHLVL", "PWD", "OLDPWD"]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !incidental.has(entry[0]),
    ),
  );
}

/** Only runtime configuration and explicitly declared application variables affect freshness. */
export function productIdentityEnvironment(
  declared: readonly string[] = [],
): Record<string, string> {
  const names = new Set(["PATH", "LANG", "TZ", "CI", ...declared]);
  return Object.fromEntries(
    Object.entries(productExecutionEnvironment()).filter(
      ([name]) => names.has(name) || /^(?:NODE_|PYTHON|LC_)/.test(name),
    ),
  );
}

/**
 * Execute checks with the same canonical browser selector represented in their identity.
 * Python bytecode (imports, py_compile, compileall) would otherwise land in __pycache__
 * and change the checked product during its own check. An operator's explicit
 * PYTHONPYCACHEPREFIX still wins.
 */
export async function resolvedProductExecutionEnvironment(): Promise<Record<string, string>> {
  const browser = await browserExecutableIdentity();
  const inherited = productExecutionEnvironment();
  return {
    PYTHONPYCACHEPREFIX: inherited.PYTHONPYCACHEPREFIX ?? (await pythonCacheDirectory()),
    ...inherited,
    CHROME_BIN: "path" in browser ? browser.path : browser.binary,
  };
}
