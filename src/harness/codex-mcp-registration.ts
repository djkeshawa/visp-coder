import { realpathSync } from "node:fs";
import { ok, type Result } from "../core/result.js";
import { runtimeIdentity } from "../core/version.js";

/** Codex reads project MCP servers from this trusted project configuration. */
export const CODEX_CONFIG_FILE = ".codex/config.toml";

const CODEX_MCP_ARGS = `[${JSON.stringify(runtimeIdentity().executable)}, "serve", "--mcp"]`;
const CODEX_MCP_ENTRY = `# visp: mcp:start\n[mcp_servers.visp]\ncommand = "node"\nargs = ${CODEX_MCP_ARGS}\n# visp: mcp:end\n`;
const LEGACY_CODEX_MCP_ENTRY =
  '# visp: mcp:start\n[mcp_servers.visp]\ncommand = "visp"\nargs = ["serve", "--mcp"]\n# visp: mcp:end\n';
const MANAGED_CODEX_MCP_ENTRY =
  /^# visp: mcp:start\n\[mcp_servers\.visp\]\ncommand = "node"\nargs = \["(?:[^"\\]|\\.)+", "serve", "--mcp"\]\n# visp: mcp:end\n$/;
/** The block VISP writes, wherever it sits in a larger file. */
const OWNED_BLOCK = /# visp: mcp:start\n[\s\S]*?# visp: mcp:end\n/u;

export type CodexRegistrationStatus = "added" | "current" | "customized" | "replaced" | "malformed";

export interface CodexRegistrationPlan {
  readonly status: CodexRegistrationStatus;
  readonly content?: string;
  /** A customized VISP entry VISP could not read, rather than one that starts another build. */
  readonly unreadable?: true;
}

export interface CodexRegistrationResidue {
  readonly exact: boolean;
  readonly customized: boolean;
  readonly malformed: boolean;
}

/**
 * Codex configuration is TOML, and VISP has no TOML parser. It owns only the
 * marked block it writes: that block is recognized and replaced wherever it
 * sits, and otherwise the table is appended when the file has no VISP server
 * and nothing that could make an appended table ambiguous. A table the user
 * wrote that starts this build is installed as it stands. Anything else is
 * left for manual integration.
 */
export function planCodexMcpRegistration(
  current: string | undefined,
  force: boolean,
): Result<CodexRegistrationPlan> {
  if (current === undefined || current.trim() === "") {
    return ok({ status: "added", content: CODEX_MCP_ENTRY });
  }
  const owned = current.match(OWNED_BLOCK)?.[0];
  if (owned !== undefined) return ok(planOwnedBlock(current, owned, force));
  // A multi-line string that never ends leaves nothing safe to read or append to.
  const masked = structure(current);
  if (masked === undefined) return ok({ status: "malformed" });
  if (referencesVisp(masked)) {
    const state = registrationState(current, masked);
    if (state === "current") return ok({ status: "current" });
    return ok({ status: "customized", ...(state === "unreadable" ? { unreadable: true } : {}) });
  }
  if (/^\s*mcp_servers\s*=/mu.test(masked)) return ok({ status: "malformed" });
  return ok({ status: "added", content: `${current.trimEnd()}\n\n${CODEX_MCP_ENTRY}` });
}

/** VISP's own marked block: current, replaced when an earlier build wrote it, else edited. */
function planOwnedBlock(current: string, owned: string, force: boolean): CodexRegistrationPlan {
  if (owned === CODEX_MCP_ENTRY) return { status: "current" };
  if (owned === LEGACY_CODEX_MCP_ENTRY || (force && MANAGED_CODEX_MCP_ENTRY.test(owned)))
    return { status: "replaced", content: current.replace(owned, CODEX_MCP_ENTRY) };
  return { status: "customized" };
}

/** Remove only the block VISP created; the rest of the Codex TOML is retained. */
export function planCodexMcpUnregistration(current: string | undefined): {
  readonly status: "absent" | "removed" | "customized" | "malformed";
  readonly content?: string;
} {
  if (current === undefined || current.trim() === "") return { status: "absent" };
  const owned = current.match(OWNED_BLOCK)?.[0];
  if (owned !== undefined && isGenerated(owned)) {
    const rest = current.replace(owned, "").replace(/\n{3,}/gu, "\n\n");
    return { status: "removed", content: rest.trim() === "" ? "" : `${rest.trimEnd()}\n` };
  }
  return referencesVisp(structure(current) ?? current)
    ? { status: "customized" }
    : { status: "absent" };
}

export function inspectCodexMcpRegistrationResidue(
  current: string | undefined,
): CodexRegistrationResidue {
  if (current === undefined || current.trim() === "") {
    return { exact: false, customized: false, malformed: false };
  }
  const owned = current.match(OWNED_BLOCK)?.[0];
  if (owned !== undefined && isGenerated(owned))
    return { exact: true, customized: false, malformed: false };
  return referencesVisp(structure(current) ?? current)
    ? { exact: false, customized: true, malformed: false }
    : { exact: false, customized: false, malformed: false };
}

function isGenerated(block: string): boolean {
  return (
    block === CODEX_MCP_ENTRY ||
    block === LEGACY_CODEX_MCP_ENTRY ||
    MANAGED_CODEX_MCP_ENTRY.test(block)
  );
}

/** A VISP server entry in any form: VISP's block, a `mcp_servers.visp` table or dotted key, or `visp = ...` under `[mcp_servers]`. */
function referencesVisp(masked: string): boolean {
  return (
    masked.includes("# visp: mcp:") ||
    /mcp_servers\s*\.\s*["']?visp\b/u.test(masked) ||
    vispUnderServersTable(masked)
  );
}

const SERVERS_TABLE = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\][ \t]*(?:#.*)?$/gmu;

function vispUnderServersTable(masked: string): boolean {
  for (const header of masked.matchAll(SERVERS_TABLE)) {
    const body = masked.slice((header.index ?? 0) + header[0].length);
    const next = body.search(/^[ \t]*\[/mu);
    if (/^[ \t]*(?:visp|"visp"|'visp')[ \t]*=/mu.test(next < 0 ? body : body.slice(0, next)))
      return true;
  }
  return false;
}

const MULTI_LINE_DELIMITERS = ['"""', "'''"] as const;

/**
 * The source with the contents of multi-line strings blanked (lengths and line breaks kept),
 * so headers and keys can be found by line without text inside a string counting. Undefined
 * when a string never ends.
 */
function structure(source: string): string | undefined {
  let out = "";
  let at = 0;
  while (at < source.length) {
    const delimiter = MULTI_LINE_DELIMITERS.find((candidate) => source.startsWith(candidate, at));
    if (delimiter) {
      const end = multiLineEnd(source, at + 3, delimiter);
      if (end === undefined) return undefined;
      out += `${delimiter}${source.slice(at + 3, end - 3).replace(/[^\n]/gu, " ")}${delimiter}`;
      at = end;
      continue;
    }
    // A one-line string or a comment is copied as it is; only its end matters, so a `"""`
    // inside it does not start a multi-line string.
    const end = oneLineEnd(source, at);
    out += source.slice(at, end);
    at = end;
  }
  return out;
}

/** Past the closing delimiter, which may follow up to two quotes of the content. */
function multiLineEnd(source: string, from: number, delimiter: string): number | undefined {
  for (let at = from; at < source.length; at++) {
    if (delimiter === '"""' && source[at] === "\\") {
      at++;
      continue;
    }
    if (!source.startsWith(delimiter, at)) continue;
    let end = at + 3;
    for (let extra = 0; extra < 2 && source[end] === delimiter[0]; extra++) end++;
    return end;
  }
  return undefined;
}

/** The end of the token at `from`: a one-line string, a comment, or one character. */
function oneLineEnd(source: string, from: number): number {
  const char = source[from];
  if (char === "#") {
    const newline = source.indexOf("\n", from);
    return newline < 0 ? source.length : newline;
  }
  if (char !== '"' && char !== "'") return from + 1;
  for (let at = from + 1; at < source.length; at++) {
    if (source[at] === "\n") return at;
    if (char === '"' && source[at] === "\\") {
      at++;
      continue;
    }
    if (source[at] === char) return at + 1;
  }
  return source.length;
}

/** What to do about a VISP server entry VISP did not write and cannot use. */
export function codexRegistrationAdvice(unreadable = false): string {
  return unreadable
    ? `write it as a [mcp_servers.visp] table with command = "node" and args = ${CODEX_MCP_ARGS}, without dotted keys or multi-line strings, or delete it and rerun visp install`
    : `set command = "node" and args = ${CODEX_MCP_ARGS} in its [mcp_servers.visp] table, or delete that table and rerun visp install`;
}

/** The problem with a VISP server entry VISP did not write, as doctor and install say it. */
export function codexRegistrationProblem(unreadable = false): string {
  return unreadable
    ? "has a VISP server entry VISP could not read"
    : "has an [mcp_servers.visp] table VISP did not write, and it does not start this VISP build";
}

/**
 * Whether a hand-written `[mcp_servers.visp]` table starts this build. Codex launches a server
 * from its command and arguments alone, so those decide: `node` (by name or path) running this
 * build's CLI (by path or a link to it) with `serve --mcp`. Other keys may differ.
 */
function registrationState(source: string, masked: string): "current" | "different" | "unreadable" {
  const table = handWrittenTable(source, masked);
  if (!table) return "unreadable";
  const { command, args } = table;
  return typeof command === "string" &&
    ["node", "node.exe"].includes(command.split(/[\\/]/u).pop() ?? "") &&
    Array.isArray(args) &&
    args.length === 3 &&
    typeof args[0] === "string" &&
    sameExecutable(args[0]) &&
    args[1] === "serve" &&
    args[2] === "--mcp"
    ? "current"
    : "different";
}

function sameExecutable(path: string): boolean {
  const executable = runtimeIdentity().executable;
  if (path === executable) return true;
  try {
    return realpathSync(path) === executable;
  } catch {
    return false;
  }
}

const VISP_TABLE =
  /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:visp|"visp"|'visp')[ \t]*\][ \t]*(?:#.*)?$/gmu;

/** The keys of the one `[mcp_servers.visp]` table, or undefined when it cannot be read safely. */
function handWrittenTable(source: string, masked: string): Record<string, unknown> | undefined {
  // Headers are found where no string can hide one; values are read from the source.
  const headers = [...masked.matchAll(VISP_TABLE)];
  const header = headers[0];
  if (headers.length !== 1 || header?.index === undefined) return undefined;
  return readTableBody(source.slice(header.index + header[0].length).replaceAll("\r\n", "\n"));
}

/** Opaque stand-in for a value VISP does not need to understand, such as a number. */
const OTHER = Symbol("other TOML value");

function readTableBody(body: string): Record<string, unknown> | undefined {
  const values: Record<string, unknown> = {};
  let rest = body;
  for (;;) {
    rest = rest.replace(/^(?:\s|#[^\n]*)*/u, "");
    if (rest === "" || rest.startsWith("[")) return values;
    const key = /^([A-Za-z0-9_-]+|"[^"\\\n]*"|'[^'\n]*')[ \t]*=[ \t]*/u.exec(rest);
    if (!key?.[1]) return undefined;
    const name = key[1].replace(/^["']|["']$/gu, "");
    if (Object.hasOwn(values, name)) return undefined;
    const value = readValue(rest.slice(key[0].length));
    if (!value) return undefined;
    values[name] = value.value;
    rest = value.rest.replace(/^[ \t]*(?:#[^\n]*)?/u, "");
    if (rest !== "" && !rest.startsWith("\n")) return undefined;
  }
}

function readValue(text: string): { value: unknown; rest: string } | undefined {
  if (text.startsWith('"""') || text.startsWith("'''")) return undefined;
  const basic = /^"((?:[^"\\\n]|\\.)*)"/u.exec(text);
  if (basic) {
    try {
      return { value: JSON.parse(basic[0]), rest: text.slice(basic[0].length) };
    } catch {
      return undefined;
    }
  }
  const literal = /^'([^'\n]*)'/u.exec(text);
  if (literal) return { value: literal[1], rest: text.slice(literal[0].length) };
  if (text.startsWith("[")) return readArray(text.slice(1));
  const other = /^[^\s#"'[\]][^\n#]*/u.exec(text);
  return other ? { value: OTHER, rest: text.slice(other[0].length) } : undefined;
}

function readArray(text: string): { value: unknown[]; rest: string } | undefined {
  const items: unknown[] = [];
  let rest = text;
  for (;;) {
    rest = rest.replace(/^(?:\s|#[^\n]*)*/u, "");
    if (rest.startsWith("]")) return { value: items, rest: rest.slice(1) };
    const item = readValue(rest);
    if (!item) return undefined;
    items.push(item.value);
    rest = item.rest.replace(/^(?:\s|#[^\n]*)*/u, "");
    if (rest.startsWith(",")) rest = rest.slice(1);
    else if (!rest.startsWith("]")) return undefined;
  }
}
