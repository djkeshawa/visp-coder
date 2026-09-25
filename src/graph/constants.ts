import type { FileLanguage } from "./types.js";

/** Values shared by more than one graph submodule. Project-wide values live in core/constants. */

/** Bumped whenever the stored snapshot shape changes incompatibly. */
export const GRAPH_SCHEMA_VERSION = 2;

/** Bytes sniffed for a NUL when deciding whether a file is binary. */
export const BINARY_SNIFF_BYTES = 8_192;

/** Parsed trees held in memory at once. */

/** Paths listed by a currency check before it stops enumerating. */
export const MAX_CURRENCY_PATHS = 100;

/** Prefix marking a relation target that is outside the repository. */
export const EXTERNAL_PREFIX = "external:";

export function externalRef(specifier: string): string {
  return `${EXTERNAL_PREFIX}${specifier}`;
}

export function isExternalRef(target: string): boolean {
  return target.startsWith(EXTERNAL_PREFIX);
}

/** Tree-sitter grammars, which are finer-grained than `Language`. */
export const GRAMMARS = ["typescript", "tsx", "javascript", "python"] as const;
export type Grammar = (typeof GRAMMARS)[number];

export const GRAMMAR_BY_EXTENSION: Readonly<Record<string, Grammar>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
};

export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, FileLanguage>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
};

/** Extension order tried when a TypeScript/JavaScript import omits one. */
export const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

export const INDEX_BASENAMES = ["index", "__init__"] as const;

/** Naming shapes that make a file a candidate test module. */
export const TEST_PATH_PATTERNS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.py",
  "**/test_*.py",
  "tests/**",
  "test/**",
  "**/__tests__/**",
] as const;

/** Imports that positively evidence a test file. */
export const TEST_FRAMEWORK_MODULES = [
  "vitest",
  "jest",
  "@jest/globals",
  "mocha",
  "node:test",
  "ava",
  "pytest",
  "unittest",
] as const;

export const TEST_DECLARING_CALLS = ["describe", "it", "test", "suite", "bench"] as const;

export const HTTP_METHOD_NAMES = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "all",
  "route",
] as const;

export const PACKAGE_JSON = "package.json";
export const TSCONFIG_JSON = "tsconfig.json";

/**
 * Extensions that hold code in a language the extractor does not parse.
 *
 * Recorded as `unsupported_language` so a Go or Rust file is honestly reported
 * as unseen. Config, documentation and data files are deliberately absent: they
 * were never candidates for parsing, so calling them "unsupported" buries the
 * unknowns that actually matter under noise.
 */
export const UNPARSED_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".rb",
  ".php",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".swift",
  ".m",
  ".mm",
  ".scala",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".lua",
  ".pl",
  ".r",
  ".dart",
  ".zig",
  ".sh",
  ".bash",
  ".vue",
  ".svelte",
]);
