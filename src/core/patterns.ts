/**
 * Glob matching for file scopes. Supports `*`, `**`, `?`, and character classes
 * over POSIX-style repository-relative paths.
 */

const CACHE = new Map<string, RegExp>();

export function matchesPattern(path: string, pattern: string): boolean {
  return toRegExp(pattern).test(normalize(path));
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(path, pattern));
}

/** The first pattern that matches, or undefined. Useful for explaining a refusal. */
export function firstMatch(path: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => matchesPattern(path, pattern));
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function toRegExp(pattern: string): RegExp {
  const cached = CACHE.get(pattern);
  if (cached) return cached;

  const compiled = new RegExp(`^${compile(normalize(pattern))}$`);
  CACHE.set(pattern, compiled);
  return compiled;
}

interface Token {
  readonly source: string;
  readonly length: number;
}

function compile(pattern: string): string {
  let source = "";
  let index = 0;

  while (index < pattern.length) {
    const token = nextToken(pattern, index);
    source += token.source;
    index += token.length;
  }

  // An explicit directory includes descendants, whether or not the author kept its slash.
  if (pattern.endsWith("/")) source += ".*";
  else if (!pattern.includes("*")) source += "(?:/.*)?";
  return source;
}

function nextToken(pattern: string, index: number): Token {
  const char = pattern[index] ?? "";
  if (char === "*") return starToken(pattern, index);
  if (char === "?") return { source: "[^/]", length: 1 };
  if (char === "[") return classToken(pattern, index);
  return { source: escapeLiteral(char), length: 1 };
}

function starToken(pattern: string, index: number): Token {
  if (pattern[index + 1] !== "*") return { source: "[^/]*", length: 1 };

  // `dir/**/file` must also match `dir/file`, so absorb the trailing slash.
  return pattern[index + 2] === "/"
    ? { source: "(?:.*/)?", length: 3 }
    : { source: ".*", length: 2 };
}

function classToken(pattern: string, index: number): Token {
  const close = pattern.indexOf("]", index + 1);
  if (close === -1) return { source: "\\[", length: 1 };

  const body = pattern.slice(index + 1, close).replace(/^!/, "^");
  return { source: `[${body}]`, length: close - index + 1 };
}

function escapeLiteral(char: string): string {
  return /[.+^${}()|\\]/.test(char) ? `\\${char}` : char;
}
