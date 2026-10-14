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
  const protection = hostFileProtection(workspace, brief);
  return [...protection.named, ...protection.guarded];
}

/**
 * The same protection, split: `named` are the scope and check inputs, which protect another
 * host's file only when they name it; `guarded` are forbidden and blocked paths, which always do.
 */
export function hostFileProtection(
  workspace: WorkspaceState,
  brief?: ProductBrief,
): HostFileProtection {
  return {
    named: sourceInputPatterns(workspace, brief),
    guarded: [
      ...(brief?.slices.flatMap((slice) => slice.scope.forbidden) ?? []),
      ...workspace.config.workflow.blockedPaths.flatMap((rule) => [
        rule,
        `${rule}/**`,
        ...(rule.includes("/") ? [] : [`**/${rule}`, `**/${rule}/**`]),
      ]),
    ],
  };
}

export interface HostFileProtection {
  readonly named: readonly string[];
  readonly guarded: readonly string[];
}

/** Only an untracked, undeclared, unprotected listed path is skipped; tracked files are hashed. */
export function skippedByproduct(
  path: string,
  tracked: boolean,
  protection: readonly string[],
): boolean {
  return !tracked && isDerivedByproduct(path) && !matchesAny(path, protection);
}

/** Instruction and settings files each coding host reads, by the `harness` names visp.yml uses. */
const HOST_FILES: Record<string, { files: readonly string[]; directories: readonly string[] }> = {
  "claude-code": { files: ["CLAUDE.md", "CLAUDE.local.md"], directories: [".claude"] },
  codex: { files: ["AGENTS.md", "AGENTS.override.md"], directories: [".codex", ".agents"] },
  opencode: { files: ["AGENTS.md", "opencode.json"], directories: [".opencode"] },
  cursor: { files: ["AGENTS.md", ".cursorrules"], directories: [".cursor"] },
  copilot: {
    files: ["AGENTS.md", ".github/copilot-instructions.md"],
    directories: [".github/instructions"],
  },
  gemini: { files: ["GEMINI.md"], directories: [".gemini"] },
  windsurf: { files: [".windsurfrules"], directories: [".windsurf"] },
};

function hostFile(
  path: string,
  host: { files: readonly string[]; directories: readonly string[] },
) {
  return (
    host.files.includes(path) ||
    host.directories.some((directory) => path === directory || path.startsWith(`${directory}/`))
  );
}

/**
 * Another coding host's instructions or settings, which the configured host never reads.
 * A desktop app importing a Claude Code project wrote AGENTS.md, .codex/ and .agents/ into
 * projects mid-run; as product files they made an acceptance stale and failed `visp done`
 * with a scope violation the worker could not resolve. Only untracked files are skipped,
 * never the configured host's own files, which are VISP's enforcement surface, and never a
 * protected path: one a slice scope or check names (a request to write an AGENTS.md), forbids
 * or the configuration blocks, so the scope check still sees it. A catch-all or extension
 * pattern (`**`, the light path's scope, or `*.md`) does not name it.
 */
export function foreignHostFile(
  path: string,
  tracked: boolean,
  harness: string,
  protection: HostFileProtection,
): boolean {
  const own = HOST_FILES[harness];
  if (tracked || !own || matchesAny(path, protection.guarded)) return false;
  const normalized = normalizePath(path);
  if (protection.named.some((pattern) => namesPath(pattern, normalized))) return false;
  return (
    !hostFile(normalized, own) &&
    Object.entries(HOST_FILES).some(
      ([name, host]) => name !== harness && hostFile(normalized, host),
    )
  );
}

/** The pattern matches the path through a literal leading part that is the path or a parent of it. */
function namesPath(pattern: string, path: string): boolean {
  const segments = normalizePath(pattern)
    .replace(/^(?:\.\/)+/, "")
    .split("/");
  const glob = segments.findIndex((segment) => /[*?[\]{}!]/.test(segment));
  const literal = (glob < 0 ? segments : segments.slice(0, glob)).join("/");
  return (
    literal !== "" &&
    (path === literal || path.startsWith(`${literal}/`)) &&
    matchesAny(path, [pattern])
  );
}
