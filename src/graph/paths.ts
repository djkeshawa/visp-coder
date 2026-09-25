import { matchesAny } from "../core/patterns.js";
import {
  GRAMMAR_BY_EXTENSION,
  type Grammar,
  LANGUAGE_BY_EXTENSION,
  PACKAGE_JSON,
  TEST_PATH_PATTERNS,
} from "./constants.js";
import type { FileLanguage } from "./types.js";

/** POSIX path arithmetic over repository-relative paths. The graph never uses OS separators. */

const GENERATED_AGENT_PREFIXES = [".visp/", ".agents/", ".claude/", ".codex/", ".cursor/"];

export function isHtmlPath(path: string): boolean {
  const extension = extensionOf(path);
  return extension === ".html" || extension === ".htm";
}

export function extensionOf(path: string): string {
  const base = basename(path);
  if (base.endsWith(".d.ts")) return ".d.ts";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}

export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function stem(path: string): string {
  const base = basename(path);
  const extension = extensionOf(base);
  return extension ? base.slice(0, base.length - extension.length) : base;
}

/** Joins and normalizes `.`/`..` segments without touching the filesystem. */
export function joinPosix(base: string, ...segments: string[]): string {
  const parts: string[] = [];
  for (const segment of [base, ...segments]) {
    for (const piece of segment.split("/")) {
      if (piece === "" || piece === ".") continue;
      if (piece === "..") parts.pop();
      else parts.push(piece);
    }
  }
  return parts.join("/");
}

export function languageForPath(path: string): FileLanguage {
  const extension = extensionOf(path);
  if (extension === ".d.ts") return "typescript";
  return LANGUAGE_BY_EXTENSION[extension] ?? "other";
}

export function grammarForPath(path: string): Grammar | undefined {
  const extension = extensionOf(path);
  if (extension === ".d.ts") return "typescript";
  return GRAMMAR_BY_EXTENSION[extension];
}

/** Whether a repository path can contribute real project structure to the graph. */
export function isIndexableProjectPath(path: string): boolean {
  if (GENERATED_AGENT_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return grammarForPath(path) !== undefined || isHtmlPath(path);
}

export function hasIndexableProjectFiles(paths: readonly string[]): boolean {
  return paths.some(isIndexableProjectPath);
}

/** Naming alone only makes a file a test *candidate*; entrypoints still need evidence. */
export function isTestPath(path: string): boolean {
  return matchesAny(path, TEST_PATH_PATTERNS);
}

export function isPackageManifest(path: string): boolean {
  return basename(path) === PACKAGE_JSON;
}
