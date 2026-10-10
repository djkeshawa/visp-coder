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

/** Values of the application variables a check declares: the only environment that is product freshness. */
export function declaredEnvironment(
  names: readonly string[] = [],
  environment: Record<string, string> = productExecutionEnvironment(),
): Record<string, string> {
  return Object.fromEntries(
    [...new Set(names)].sort().flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

// Anything that changes what a program loads, how it starts or which package settings it reads.
// Over-inclusion only costs a re-run; a missing name lets a pass stand for another toolchain.
const INJECTION_NAME =
  /^(?:NODE_|PYTHON|DYLD_|PYTEST_|PLAYWRIGHT_|PERL5)|^npm_config_|^(?:LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|BASH_ENV|ENV|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|RUBYOPT|RUBYLIB|GOFLAGS|SHELLOPTS|BASHOPTS)$/i;
const LOCALE_NAME =
  /^(?:LANG|LC_ALL|LC_COLLATE|LC_CTYPE|LC_MESSAGES|LC_MONETARY|LC_NUMERIC|LC_TIME|TZ|CI)$/;

/**
 * Toolchain injection and locale exactly as a check sees them. They decide whether evidence
 * from one run may stand for another (comparison identity), never whether the product changed.
 */
export function comparisonEnvironmentParts(
  environment: Record<string, string>,
  ownBytecodeCache?: string,
) {
  const pick = (test: (name: string) => boolean) =>
    Object.fromEntries(
      Object.entries(environment)
        .filter(([name]) => test(name))
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  return {
    // VISP sets the bytecode prefix itself for every check; an operator's own value stays.
    injection: pick(
      (name) =>
        INJECTION_NAME.test(name) &&
        !(name === "PYTHONPYCACHEPREFIX" && environment[name] === ownBytecodeCache),
    ),
    locale: pick((name) => LOCALE_NAME.test(name)),
  };
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
