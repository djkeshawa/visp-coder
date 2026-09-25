import { basename, isAbsolute, posix } from "node:path";
import { resolveCommand } from "../../core/exec.js";
import { hashValue } from "../../core/hash.js";
import { matchesAny, matchesPattern } from "../../core/patterns.js";
import { isBrowserCheckCommand } from "./check-command.js";
import type { ProductCheck } from "./model.js";

const NODE_PRELOAD_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
]);
const NODE_VALUE_FLAGS = new Set([
  "--conditions",
  "-C",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--input-type",
]);

/** Bind the executable check and its declared verifier inputs, separately from repaired source. */
export function productVerifierDigest(check: ProductCheck, snapshot: Record<string, string>) {
  const patterns = check.verifierFiles ?? [];
  const paths = Object.keys(snapshot)
    .filter((path) => matchesAny(path, patterns))
    .sort();
  const entryFiles = explicitNodeFiles(check);
  if (
    !patterns.length ||
    entryFiles === undefined ||
    entryFiles.some((path) => !paths.includes(path)) ||
    // Source snapshots retain exact absent paths with this identity.
    paths.some((path) => snapshot[path] === hashValue({ hash: null })) ||
    patterns.some((pattern) => !paths.some((path) => matchesPattern(path, pattern)))
  )
    return undefined;
  return hashValue({
    version: 1,
    check,
    files: Object.fromEntries(paths.map((path) => [path, snapshot[path]])),
  });
}

/** Explicit Node file arguments are known verifier inputs; imports remain declaration-owned. */
function explicitNodeFiles(check: ProductCheck): string[] | undefined {
  if (isBrowserCheckCommand(check.command)) return [];
  const resolved = resolveCommand(check.command);
  if (!resolved.ok) return undefined;
  if (!/^node(?:js|\d+(?:\.\d+)*)?$/.test(basename(resolved.value[0] ?? ""))) return [];
  const files: string[] = [];
  const args = resolved.value.slice(1);
  for (let index = 0; index < args.length; index++) {
    const input = nodeInput(args, index);
    index = input.next;
    if (input.kind === "eval") return files;
    if (input.kind === "skip") continue;
    const path = declaredNodePath(input);
    if (!path) return undefined;
    files.push(path);
    if (input.kind === "entry") return files;
  }
  return undefined;
}

function declaredNodePath(input: ReturnType<typeof nodeInput>): string | undefined {
  const path = input.path ?? "";
  return input.kind === "input" ? repositoryPath(path) : nodeFilePath(path);
}

function nodeInput(
  args: readonly string[],
  index: number,
): {
  kind: "eval" | "skip" | "preload" | "input" | "entry";
  next: number;
  path?: string;
} {
  const argument = args[index] ?? "";
  if (/^(?:-e|-p|--eval|--print)(?:=|$)/.test(argument)) return { kind: "eval", next: index };
  if (NODE_PRELOAD_FLAGS.has(argument))
    return { kind: "preload", next: index + 1, path: args[index + 1] };
  const inlinePreload = argument.match(/^--(?:require|import|loader|experimental-loader)=(.+)$/);
  if (inlinePreload) return { kind: "preload", next: index, path: inlinePreload[1] };
  if (argument === "--env-file" || argument === "--env-file-if-exists")
    return { kind: "input", next: index + 1, path: args[index + 1] };
  const inlineInput = argument.match(/^--env-file(?:-if-exists)?=(.+)$/);
  if (inlineInput) return { kind: "input", next: index, path: inlineInput[1] };
  if (NODE_VALUE_FLAGS.has(argument)) return { kind: "skip", next: index + 1 };
  if (argument.startsWith("-")) return { kind: "skip", next: index };
  return { kind: "entry", next: index, path: argument };
}

function nodeFilePath(argument: string): string | undefined {
  if (!/\.[cm]?[jt]sx?$/.test(argument)) return undefined;
  return repositoryPath(argument);
}

function repositoryPath(argument: string): string | undefined {
  if (isAbsolute(argument) || argument.includes("://")) return undefined;
  const path = posix.normalize(argument);
  return path === "." || path === ".." || path.startsWith("../") ? undefined : path;
}
