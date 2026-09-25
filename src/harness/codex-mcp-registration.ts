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

/**
 * Codex configuration is TOML, so VISP only writes a new file or recognizes
 * the exact block it owns. Existing TOML is preserved for manual integration.
 */
export function planCodexMcpRegistration(
  current: string | undefined,
  _force: boolean,
): Result<CodexRegistrationPlan> {
  if (current === undefined || current.trim() === "") {
    return ok({ status: "added", content: CODEX_MCP_ENTRY });
  }
  if (current === CODEX_MCP_ENTRY) return ok({ status: "current" });
  return ok({ status: referencesVisp(current) ? "customized" : "malformed" });
}

/** Remove only the exact file VISP created; arbitrary Codex TOML is retained. */
export function planCodexMcpUnregistration(current: string | undefined): {
  readonly status: "absent" | "removed" | "customized" | "malformed";
  readonly content?: string;
} {
  if (current === undefined || current.trim() === "") return { status: "absent" };
  if (current === CODEX_MCP_ENTRY) return { status: "removed", content: "" };
  return referencesVisp(current) ? { status: "customized" } : { status: "absent" };
}

export function inspectCodexMcpRegistrationResidue(
  current: string | undefined,
): CodexRegistrationResidue {
  if (current === undefined || current.trim() === "") {
    return { exact: false, customized: false, malformed: false };
  }
  if (current === CODEX_MCP_ENTRY) return { exact: true, customized: false, malformed: false };
  return referencesVisp(current)
    ? { exact: false, customized: true, malformed: false }
    : { exact: false, customized: false, malformed: false };
}

function referencesVisp(source: string): boolean {
  return source.includes("# visp: mcp:") || /mcp_servers\s*\.\s*["']?visp\b/u.test(source);
}
