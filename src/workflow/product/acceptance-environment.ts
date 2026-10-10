import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Candidate and pinned tests receive only runtime selectors, never operator credentials.
 * Without `home` they share the machine's temporary directory as HOME; a caller that owns a
 * private directory passes it, so concurrent runs share no Chrome profile lock or leftovers.
 */
export function acceptanceEnvironment(
  environment: Record<string, string>,
  home?: string,
): Record<string, string> {
  // Windows variable names are case-insensitive ("Path", "ComSpec"), and its command shims need PATHEXT and ComSpec.
  const allowed = new Set([
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "SYSTEMROOT",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "TEMP",
    "TMP",
    "PYTHONPYCACHEPREFIX",
    "CHROME_BIN",
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([name]) => allowed.has(name.toUpperCase())),
    ),
    HOME: home ?? tmpdir(),
    USERPROFILE: home ?? tmpdir(),
    TMPDIR: home === undefined ? tmpdir() : privateTemporaryDirectory(home),
    ...(home === undefined
      ? {}
      : { TEMP: privateTemporaryDirectory(home), TMP: privateTemporaryDirectory(home) }),
  };
}

/** The temporary directory inside a private home; the caller creates both. */
export function privateTemporaryDirectory(home: string): string {
  return join(home, "tmp");
}
