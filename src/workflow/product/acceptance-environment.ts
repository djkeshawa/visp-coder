import { tmpdir } from "node:os";

/** Candidate and pinned tests receive only runtime selectors, never operator credentials. */
export function acceptanceEnvironment(environment: Record<string, string>): Record<string, string> {
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
    HOME: tmpdir(),
    USERPROFILE: tmpdir(),
    TMPDIR: tmpdir(),
  };
}
