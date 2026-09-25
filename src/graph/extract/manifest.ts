import type { Entrypoint, UnknownRecord } from "../types.js";

/**
 * `package.json` declares entrypoints outright, so they are read rather than
 * inferred. A manifest that will not parse is an unknown, not an empty result.
 */

export interface ManifestFacts {
  readonly entrypoints: Entrypoint[];
  readonly unknowns: UnknownRecord[];
}

const MAX_EXPORTS_DEPTH = 6;

export function extractManifest(path: string, source: string): ManifestFacts {
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { entrypoints: [], unknowns: [{ kind: "parser_error", path, detail }] };
  }

  const record = asRecord(manifest);
  if (!record) {
    return {
      entrypoints: [],
      unknowns: [{ kind: "parser_error", path, detail: "manifest is not an object" }],
    };
  }

  const lines = source.split("\n");
  const entrypoints: Entrypoint[] = [
    ...fieldEntrypoints(path, record, lines),
    ...binEntrypoints(path, record, lines),
    ...exportEntrypoints(path, record.exports, lines, "exports", 0),
    ...scriptEntrypoints(path, record.scripts, lines),
  ];
  return { entrypoints, unknowns: [] };
}

function fieldEntrypoints(
  path: string,
  record: Record<string, unknown>,
  lines: string[],
): Entrypoint[] {
  const found: Entrypoint[] = [];
  for (const key of ["main", "module", "browser", "types"]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    found.push(manifestEntry(path, key, lineOfKey(lines, key), `"${key}": "${value}"`));
  }
  return found;
}

function binEntrypoints(
  path: string,
  record: Record<string, unknown>,
  lines: string[],
): Entrypoint[] {
  const bin = record.bin;
  const line = lineOfKey(lines, "bin");
  if (typeof bin === "string") {
    return [manifestEntry(path, "bin", line, `"bin": "${bin}"`)];
  }
  const asObject = asRecord(bin);
  if (!asObject) return [];
  return Object.entries(asObject)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, target]) =>
      manifestEntry(path, name, lineOfKey(lines, name, line), `"bin.${name}": "${target}"`),
    );
}

function exportEntrypoints(
  path: string,
  value: unknown,
  lines: string[],
  label: string,
  depth: number,
): Entrypoint[] {
  if (depth > MAX_EXPORTS_DEPTH) return [];
  if (typeof value === "string") {
    return [manifestEntry(path, label, lineOfKey(lines, "exports"), `"${label}": "${value}"`)];
  }

  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, nested]) =>
    exportEntrypoints(path, nested, lines, `${label}${exportSuffix(key)}`, depth + 1),
  );
}

function exportSuffix(key: string): string {
  if (key === ".") return "";
  return key.startsWith(".") ? key : `.${key}`;
}

function scriptEntrypoints(path: string, value: unknown, lines: string[]): Entrypoint[] {
  const record = asRecord(value);
  if (!record) return [];
  const scriptsLine = lineOfKey(lines, "scripts");

  return Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, command]) => ({
      kind: "package_script" as const,
      path,
      name,
      line: lineOfKey(lines, name, scriptsLine),
      evidence: `"scripts.${name}": "${truncate(command)}"`,
    }));
}

function manifestEntry(path: string, name: string, line: number, evidence: string): Entrypoint {
  return { kind: "package_entrypoint", path, name, line, evidence };
}

/** Best-effort line for a key, so a reader can find the declaration. */
function lineOfKey(lines: string[], key: string, from = 1): number {
  const needle = `"${key}"`;
  for (let index = Math.max(from - 1, 0); index < lines.length; index += 1) {
    if ((lines[index] ?? "").includes(needle)) return index + 1;
  }
  return 1;
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
