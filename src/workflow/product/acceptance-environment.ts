import { tmpdir } from "node:os";

/** Candidate and pinned tests receive only runtime selectors, never operator credentials. */
export function acceptanceEnvironment(environment: Record<string, string>): Record<string, string> {
  const allowed = new Set([
    "PATH",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "TEMP",
    "TMP",
    "PYTHONPYCACHEPREFIX",
    "CHROME_BIN",
  ]);
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => allowed.has(name))),
    HOME: tmpdir(),
    USERPROFILE: tmpdir(),
    TMPDIR: tmpdir(),
  };
}
