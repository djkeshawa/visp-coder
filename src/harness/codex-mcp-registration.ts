import { ok, type Result } from "../core/result.js";

/** Codex reads project MCP servers from this trusted project configuration. */
export const CODEX_CONFIG_FILE = ".codex/config.toml";

const CODEX_MCP_ENTRY =
  '# visp: mcp:start\n[mcp_servers.visp]\ncommand = "visp"\nargs = ["serve", "--mcp"]\n# visp: mcp:end\n';

export type CodexRegistrationStatus = "added" | "current" | "customized" | "malformed";

export interface CodexRegistrationPlan {
  readonly status: CodexRegistrationStatus;
  readonly content?: string;
}

export interface CodexRegistrationResidue {
  readonly exact: boolean;
  readonly customized: boolean;
  readonly malformed: boolean;
}

/** Preserve unrelated TOML and append the generated table only when unambiguous. */
export function planCodexMcpRegistration(
  current: string | undefined,
  _force: boolean,
): Result<CodexRegistrationPlan> {
  if (current === undefined || current.trim() === "") {
    return ok({ status: "added", content: CODEX_MCP_ENTRY });
  }
  if (current === CODEX_MCP_ENTRY) return ok({ status: "current" });
  const table = /^\s*\[mcp_servers\.visp\]\s*$/gmu;
  const matches = [...current.matchAll(table)];
  if (matches.length === 1 && !current.includes('"""')) {
    const start = (matches[0]?.index ?? 0) + (matches[0]?.[0]?.length ?? 0);
    const rest = current.slice(start);
    const end = rest.search(/^\s*\[/mu);
    const body = (end < 0 ? rest : rest.slice(0, end))
      .split("\n")
      .map((line) => line.replace(/#.*$/u, "").trim())
      .filter(Boolean);
    const values = new Set(body);
    return ok({
      status:
        body.length === 2 &&
        values.has('command = "visp"') &&
        values.has('args = ["serve", "--mcp"]')
          ? "current"
          : "customized",
    });
  }
  if (referencesVisp(current)) return ok({ status: "customized" });
  if (/^\s*mcp_servers\s*=/mu.test(current) || current.includes('"""'))
    return ok({ status: "malformed" });
  return ok({ status: "added", content: `${current.trimEnd()}\n\n${CODEX_MCP_ENTRY}` });
}

/** Remove only the exact file VISP created; arbitrary Codex TOML is retained. */
export function planCodexMcpUnregistration(current: string | undefined): {
  readonly status: "absent" | "removed" | "customized" | "malformed";
  readonly content?: string;
} {
  if (current === undefined || current.trim() === "") return { status: "absent" };
  if (current === CODEX_MCP_ENTRY) return { status: "removed", content: "" };
  if (current.endsWith(`\n${CODEX_MCP_ENTRY}`))
    return { status: "removed", content: current.slice(0, -CODEX_MCP_ENTRY.length - 1) };
  return referencesVisp(current) ? { status: "customized" } : { status: "absent" };
}

export function inspectCodexMcpRegistrationResidue(
  current: string | undefined,
): CodexRegistrationResidue {
  if (current === undefined || current.trim() === "") {
    return { exact: false, customized: false, malformed: false };
  }
  if (current === CODEX_MCP_ENTRY) return { exact: true, customized: false, malformed: false };
  if (current.endsWith(`\n${CODEX_MCP_ENTRY}`))
    return { exact: true, customized: false, malformed: false };
  return referencesVisp(current)
    ? { exact: false, customized: true, malformed: false }
    : { exact: false, customized: false, malformed: false };
}

function referencesVisp(source: string): boolean {
  return source.includes("# visp: mcp:") || /mcp_servers\s*\.\s*["']?visp\b/u.test(source);
}
