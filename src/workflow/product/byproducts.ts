import { matchesAny, normalizePath } from "../../core/patterns.js";
import type { WorkspaceState } from "../state.js";
import type { ProductBrief } from "./model.js";
import { sourceInputPatterns } from "./source-inputs.js";

/**
 * Cache and editor directories at any depth. A script, page or native module inside one is
 * still importable or runnable, so it stays product; only their own output is skipped
 * (bytecode is imported only from `__pycache__/` and only when its source matches).
 */
const CACHE_DIRECTORIES = new Set([
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".playwright-mcp",
  ".idea",
]);
const FILES = new Set([".coverage", ".DS_Store", "Thumbs.db"]);
/** Code that a program can load or run, whatever directory it sits in. */
const SOURCE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|py|rb|sh|php|go|rs|java|html?|css|wasm|so|pyd|pth|node)$/i;
/** Reports and logs a test run or a server writes at the repository root; deeper paths stay product. */
const REPORT_DIRECTORIES = new Set([
  "coverage",
  "htmlcov",
  ".nyc_output",
  "test-results",
  "playwright-report",
]);
const LOG_DIRECTORIES = new Set(["logs", "log"]);

/**
 * Untracked output a tool or a server leaves behind. It must not change the product's
 * identity or abort a capture. `dist/`, `build/`, databases and source files are never
 * listed: they can be the product. Report directories (coverage/, htmlcov/) are skipped
 * whole, so a check that reads a report from one must declare it as an input.
 */
export function isDerivedByproduct(path: string): boolean {
  const segments = normalizePath(path).split("/");
  const name = segments.at(-1) ?? "";
  const directories = segments.slice(0, -1);
  const root = directories[0];
  const source = SOURCE_EXTENSION.test(name);
  return (
    (directories.some((segment) => CACHE_DIRECTORIES.has(segment)) && !source) ||
    FILES.has(name) ||
    (directories.length === 0 && name.endsWith(".log")) ||
    (root !== undefined && REPORT_DIRECTORIES.has(root)) ||
    (root !== undefined && LOG_DIRECTORIES.has(root) && !source) ||
    segments.slice(-2).join("/") === ".claude/settings.local.json"
  );
}

/**
 * Paths a byproduct must never hide: everything a slice scope names (allowed, expected and
 * forbidden, so a forbidden write there is still reported), every declared check input, and
 * whatever the configuration blocks. The scope check reads the same snapshot.
 */
export function byproductProtection(workspace: WorkspaceState, brief?: ProductBrief): string[] {
  return [
    ...sourceInputPatterns(workspace, brief),
    ...(brief?.slices.flatMap((slice) => slice.scope.forbidden) ?? []),
    ...workspace.config.workflow.blockedPaths.flatMap((rule) => [
      rule,
      `${rule}/**`,
      ...(rule.includes("/") ? [] : [`**/${rule}`, `**/${rule}/**`]),
    ]),
  ];
}

/** Only an untracked, undeclared, unprotected listed path is skipped; tracked files are hashed. */
export function skippedByproduct(
  path: string,
  tracked: boolean,
  protection: readonly string[],
): boolean {
  return !tracked && isDerivedByproduct(path) && !matchesAny(path, protection);
}
