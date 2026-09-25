/**
 * Which repository files a failure's output names. Deterministic: a token
 * counts only when it resolves to a file that actually exists, so a stack
 * frame in `node_modules` or a misparsed word can never steer a context pack.
 */

const DEFAULT_LIMIT = 10;

/**
 * Path-shaped tokens: something with a directory or extension, optionally
 * carrying the location suffixes real tools emit — `src/x.ts:10:5` (node,
 * vitest), `src/x.ts(10,5)` (tsc), `file:///abs/src/x.ts:10` (ESM stacks).
 */
const PATH_TOKEN =
  /(?:file:\/\/)?(?:[A-Za-z]:)?[\w@./\\-]+\.[A-Za-z][A-Za-z0-9]*(?:[:(]\d+(?:[:,]\d+)?\)?)?/g;

export function extractFailurePaths(
  outputs: readonly string[],
  knownFiles: readonly string[],
  limit = DEFAULT_LIMIT,
): string[] {
  const known = new Set(knownFiles);
  const found: string[] = [];
  const seen = new Set<string>();

  for (const output of outputs) {
    for (const token of output.matchAll(PATH_TOKEN)) {
      const path = resolveToken(token[0], known, knownFiles);
      if (path === undefined || seen.has(path)) continue;
      seen.add(path);
      // First mention first: the top frame of a stack trace is the one that failed.
      found.push(path);
    }
  }

  return found.slice(0, Math.max(0, limit));
}

/**
 * A token counts if it is a known file, or a known file is a path suffix of it
 * — which is how an absolute path resolves to its repo-relative name without
 * guessing at the repository root.
 */
function resolveToken(
  raw: string,
  known: ReadonlySet<string>,
  knownFiles: readonly string[],
): string | undefined {
  const cleaned = raw
    .replace(/^file:\/\//, "")
    .replace(/[:(]\d+(?:[:,]\d+)?\)?$/, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

  if (known.has(cleaned)) return cleaned;
  return knownFiles.find((file) => cleaned.endsWith(`/${file}`));
}
