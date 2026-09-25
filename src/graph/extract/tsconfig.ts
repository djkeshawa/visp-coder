import { relative, resolve } from "node:path";
import { ProjectFileSystem } from "../../core/fs.js";
import { sha256 } from "../../core/hash.js";
import { isInside, isPortableAbsolute, toPosix } from "../../core/paths.js";
import { TSCONFIG_JSON } from "../constants.js";
import { dirname, joinPosix } from "../paths.js";

/**
 * Path aliases declared in `tsconfig.json`, flattened across `extends` chains.
 * Targets are repository-relative so they can be checked against the walk.
 */
export interface PathAlias {
  readonly pattern: string;
  readonly targets: readonly string[];
}

export interface AliasTable {
  readonly aliases: readonly PathAlias[];
  /** Config files that could not be read or parsed; reported as unknowns upstream. */
  readonly problems: readonly string[];
}

export interface AliasSources extends AliasTable {
  /** Includes missing/unreadable parents: creating or fixing one changes extraction. */
  readonly sources: readonly { readonly path: string; readonly identity: string }[];
}

const MAX_EXTENDS_DEPTH = 8;

export async function loadAliases(
  root: string,
  configPath = TSCONFIG_JSON,
  files = new ProjectFileSystem(root),
): Promise<AliasSources> {
  const aliases: PathAlias[] = [];
  const problems: string[] = [];
  const sources: { path: string; identity: string }[] = [];
  await collect(files, configPath, aliases, problems, sources, 0, new Set());
  return { aliases, problems, sources };
}

async function collect(
  files: ProjectFileSystem,
  configPath: string,
  aliases: PathAlias[],
  problems: string[],
  sources: { path: string; identity: string }[],
  depth: number,
  seen: Set<string>,
): Promise<void> {
  if (depth > MAX_EXTENDS_DEPTH || seen.has(configPath)) {
    problems.push(`${configPath}: cyclic or excessive extends chain`);
    return;
  }
  seen.add(configPath);

  const read = await files.readTextIfExists(configPath);
  if (!read.ok) {
    sources.push({ path: configPath, identity: `unreadable:${read.error.code}` });
    problems.push(configPath);
    return;
  }
  if (read.value === undefined) {
    sources.push({ path: configPath, identity: "missing" });
    if (depth > 0) problems.push(configPath);
    return;
  }

  sources.push({ path: configPath, identity: sha256(read.value) });

  const parsed = parseJsonc(read.value);
  if (!parsed) {
    problems.push(configPath);
    return;
  }

  const base = dirname(configPath);
  const extendsValue = readString(parsed, "extends");
  // A parent's aliases apply only where the child does not override them.
  if (extendsValue) {
    const parent = relativeConfigPath(files.root, base, extendsValue);
    if (parent === undefined) problems.push(`${configPath} extends ${extendsValue}`);
    else await collect(files, parent, aliases, problems, sources, depth + 1, seen);
  }

  aliases.unshift(...readAliases(parsed, base));
}

function relativeConfigPath(root: string, base: string, path: string): string | undefined {
  if (isPortableAbsolute(path) || !path.startsWith(".")) return undefined;
  // Resolve before confinement: rejecting every '..' rejects safe nested inheritance,
  // while joinPosix would silently discard an attempted escape above the root.
  const absolute = resolve(root, base, path.replace(/\\/g, "/"));
  if (!isInside(root, absolute)) return undefined;
  return toPosix(relative(root, absolute));
}

function readAliases(config: Record<string, unknown>, configDir: string): PathAlias[] {
  const options = asRecord(config.compilerOptions);
  if (!options) return [];

  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : ".";
  const paths = asRecord(options.paths);
  if (!paths) return [];

  const aliases: PathAlias[] = [];
  for (const [pattern, value] of Object.entries(paths)) {
    if (!Array.isArray(value)) continue;
    const targets = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => joinPosix(configDir, baseUrl, entry));
    if (targets.length > 0) aliases.push({ pattern, targets });
  }
  return aliases.sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** tsconfig files are JSON with comments and trailing commas; both are stripped here. */
export function parseJsonc(text: string): Record<string, unknown> | undefined {
  const withoutComments = stripTrailingCommas(stripComments(text));
  try {
    const parsed: unknown = JSON.parse(withoutComments);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function stripTrailingCommas(text: string): string {
  const output: string[] = [];
  let inString = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (!inString && char === "," && closesContainer(text, index + 1)) {
      index += 1;
      continue;
    }
    const step: Step = inString ? insideString(text, index) : outsideString(text, index);
    output.push(step.emit);
    index += step.width;
    inString = step.inString;
  }
  return output.join("");
}

function closesContainer(text: string, from: number): boolean {
  let index = from;
  while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
  return text[index] === "}" || text[index] === "]";
}

interface Step {
  readonly emit: string;
  readonly width: number;
  readonly inString: boolean;
}

function stripComments(text: string): string {
  let output = "";
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const step: Step = inString ? insideString(text, index) : outsideString(text, index);
    output += step.emit;
    index += step.width;
    inString = step.inString;
  }
  return output;
}

function insideString(text: string, index: number): Step {
  const char = text[index] ?? "";
  if (char === "\\") return { emit: char + (text[index + 1] ?? ""), width: 2, inString: true };
  return { emit: char, width: 1, inString: char !== '"' };
}

function outsideString(text: string, index: number): Step {
  const char = text[index] ?? "";
  const next = text[index + 1];

  if (char === "/" && next === "/") return skipComment(text, index, index, "\n", 0);
  if (char === "/" && next === "*") return skipComment(text, index, index + 2, "*/", 2);
  return { emit: char, width: 1, inString: char === '"' };
}

/** Consumes a comment, leaving its terminator (a newline) for the next step. */
function skipComment(
  text: string,
  start: number,
  searchFrom: number,
  terminator: string,
  tail: number,
): Step {
  const end = text.indexOf(terminator, searchFrom);
  const stop = end === -1 ? text.length : end + tail;
  return { emit: "", width: Math.max(stop - start, 1), inString: false };
}
