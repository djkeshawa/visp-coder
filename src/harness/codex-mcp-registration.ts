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
  if (owned !== undefined) {
    if (owned === CODEX_MCP_ENTRY) return ok({ status: "current" });
    if (owned === LEGACY_CODEX_MCP_ENTRY || (force && MANAGED_CODEX_MCP_ENTRY.test(owned)))
      return ok({ status: "replaced", content: current.replace(owned, CODEX_MCP_ENTRY) });
    return ok({ status: "customized" });
  }
  if (referencesVisp(current))
    return ok({ status: startsThisBuild(current) ? "current" : "customized" });
  if (/^\s*mcp_servers\s*=/mu.test(current) || current.includes('"""'))
    return ok({ status: "malformed" });
  return ok({ status: "added", content: `${current.trimEnd()}\n\n${CODEX_MCP_ENTRY}` });
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
  return referencesVisp(current) ? { status: "customized" } : { status: "absent" };
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
  return referencesVisp(current)
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

function referencesVisp(source: string): boolean {
  return source.includes("# visp: mcp:") || /mcp_servers\s*\.\s*["']?visp\b/u.test(source);
}

/** What to do about a `[mcp_servers.visp]` table VISP did not write and cannot use. */
export function codexRegistrationAdvice(): string {
  return `set command = "node" and args = ${CODEX_MCP_ARGS} in its [mcp_servers.visp] table, or delete that table and rerun visp install`;
}

/**
 * Whether a hand-written `[mcp_servers.visp]` table starts this build. Codex launches a server
 * from its command and arguments alone, so those decide: `node` (by name or path) running this
 * build's CLI (by path or a link to it) with `serve --mcp`. Other keys may differ.
 */
function startsThisBuild(source: string): boolean {
  const table = handWrittenTable(source);
  if (!table) return false;
  const { command, args } = table;
  return (
    typeof command === "string" &&
    ["node", "node.exe"].includes(command.split(/[\\/]/u).pop() ?? "") &&
    Array.isArray(args) &&
    args.length === 3 &&
    typeof args[0] === "string" &&
    sameExecutable(args[0]) &&
    args[1] === "serve" &&
    args[2] === "--mcp"
  );
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
function handWrittenTable(source: string): Record<string, unknown> | undefined {
  // A multi-line string could hold text that looks like a table header.
  if (source.includes('"""') || source.includes("'''")) return undefined;
  const text = source.replaceAll("\r\n", "\n");
  const headers = [...text.matchAll(VISP_TABLE)];
  const header = headers[0];
  if (headers.length !== 1 || header?.index === undefined) return undefined;
  return readTableBody(text.slice(header.index + header[0].length));
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
