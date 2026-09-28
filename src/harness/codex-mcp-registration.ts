import { ok, type Result } from "../core/result.js";
import { runtimeIdentity } from "../core/version.js";

/** Codex reads project MCP servers from this trusted project configuration. */
export const CODEX_CONFIG_FILE = ".codex/config.toml";

const CODEX_MCP_ENTRY = `# visp: mcp:start\n[mcp_servers.visp]\ncommand = "node"\nargs = [${JSON.stringify(runtimeIdentity().executable)}, "serve", "--mcp"]\n# visp: mcp:end\n`;
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
 * and nothing that could make an appended table ambiguous. Anything else is
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
  if (referencesVisp(current)) return ok({ status: "customized" });
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
