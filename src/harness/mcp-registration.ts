import { isDeepStrictEqual } from "node:util";
import { type Harness, PRODUCT_NAME } from "../core/constants.js";
import { ok, type Result } from "../core/result.js";
import {
  CODEX_CONFIG_FILE,
  inspectCodexMcpRegistrationResidue,
  planCodexMcpRegistration,
  planCodexMcpUnregistration,
} from "./codex-mcp-registration.js";

/**
 * Registers visp as an MCP server in the harness's project configuration,
 * merging into whatever is already there. Other servers are left untouched:
 * clobbering a project's MCP configuration to add one entry would be a poor
 * trade.
 */

export const MCP_CONFIG_FILE = ".mcp.json";
export const OPENCODE_CONFIG_FILE = "opencode.json";
export const CURSOR_CONFIG_FILE = ".cursor/mcp.json";
export const COPILOT_CONFIG_FILE = ".vscode/mcp.json";
export const MCP_SERVER_NAME = PRODUCT_NAME;
export const MCP_AWARE_HARNESSES: readonly Harness[] = [
  "claude-code",
  "codex",
  "cursor",
  "copilot",
  "opencode",
];
export { CODEX_CONFIG_FILE } from "./codex-mcp-registration.js";

export type RegistrationStatus = "added" | "current" | "customized" | "replaced" | "malformed";

type McpConfig = Record<string, unknown>;

const MCP_JSON_ENTRY = {
  command: PRODUCT_NAME,
  args: ["serve", "--mcp"],
} as const;

const COPILOT_ENTRY = {
  type: "stdio",
  ...MCP_JSON_ENTRY,
} as const;

const OPENCODE_ENTRY = {
  type: "local",
  command: [PRODUCT_NAME, "serve", "--mcp"],
} as const;

interface RegistrationShape {
  readonly file: string;
  readonly container: string;
  readonly entry: unknown;
}

function registrationShape(harness: Harness): RegistrationShape {
  if (harness === "opencode")
    return { file: OPENCODE_CONFIG_FILE, container: "mcp", entry: OPENCODE_ENTRY };
  if (harness === "cursor")
    return { file: CURSOR_CONFIG_FILE, container: "mcpServers", entry: MCP_JSON_ENTRY };
  if (harness === "copilot")
    return { file: COPILOT_CONFIG_FILE, container: "servers", entry: COPILOT_ENTRY };
  return { file: MCP_CONFIG_FILE, container: "mcpServers", entry: MCP_JSON_ENTRY };
}

export function mcpConfigFile(harness: Harness): string {
  if (harness === "codex") return CODEX_CONFIG_FILE;
  return registrationShape(harness).file;
}

export interface PlannedMcpRegistration {
  readonly status: RegistrationStatus;
  readonly content?: string;
}

export type McpUnregistrationStatus = "absent" | "removed" | "customized" | "malformed";

export interface PlannedMcpUnregistration {
  readonly status: McpUnregistrationStatus;
  readonly content?: string;
}

export interface McpRegistrationResidue {
  readonly exact: boolean;
  readonly customized: boolean;
  readonly malformed: boolean;
}

/** Pure registration merge for transactional installers. */
export function planMcpRegistration(
  current: string | undefined,
  force: boolean,
  harness: Harness = "claude-code",
): Result<PlannedMcpRegistration> {
  if (harness === "codex") return planCodexMcpRegistration(current, force);
  const shape = registrationShape(harness);
  let config: McpConfig = {};
  if (current !== undefined && current.trim() !== "") {
    const parsed = parseConfig(current);
    if (!parsed) return ok({ status: "malformed" });
    config = parsed;
  }

  const containerPresent = Object.hasOwn(config, shape.container);
  const existingServers = objectRecord(config[shape.container]);
  if (containerPresent && !existingServers) return ok({ status: "malformed" });

  const servers = { ...(existingServers ?? {}) };
  const existing = servers[MCP_SERVER_NAME];

  if (existing !== undefined) {
    if (isDeepStrictEqual(existing, shape.entry)) return ok({ status: "current" });
    if (!force) return ok({ status: "customized" });
  }

  servers[MCP_SERVER_NAME] = shape.entry;
  return ok({
    status: existing !== undefined ? "replaced" : "added",
    content: formatConfig({ ...config, [shape.container]: servers }),
  });
}

/** Removes only the exact generated VISP server entry and preserves every other setting. */
export function planMcpUnregistration(
  current: string | undefined,
  harness: Harness,
): PlannedMcpUnregistration {
  if (harness === "codex") return planCodexMcpUnregistration(current);
  const shape = registrationShape(harness);
  const parsed = parseConfigText(current);
  if (parsed === "malformed") return { status: "malformed" };

  const containerPresent = Object.hasOwn(parsed, shape.container);
  const existingServers = objectRecord(parsed[shape.container]);
  if (containerPresent && !existingServers) return { status: "malformed" };
  const existing = existingServers?.[MCP_SERVER_NAME];
  if (existing === undefined) return { status: "absent" };
  if (!isDeepStrictEqual(existing, shape.entry)) return { status: "customized" };

  const servers = { ...existingServers };
  delete servers[MCP_SERVER_NAME];
  return {
    status: "removed",
    content: formatConfig({ ...parsed, [shape.container]: servers }),
  };
}

/** Distinguishes a removable generated entry from config that requires manual review. */
export function inspectMcpRegistrationResidue(
  current: string | undefined,
  harness: Harness,
): McpRegistrationResidue {
  if (harness === "codex") return inspectCodexMcpRegistrationResidue(current);
  const shape = registrationShape(harness);
  const parsed = parseConfigText(current);
  if (parsed === "malformed") {
    return {
      exact: false,
      customized: false,
      malformed: mentionsVispServer(current),
    };
  }

  const containerPresent = Object.hasOwn(parsed, shape.container);
  const existingServers = objectRecord(parsed[shape.container]);
  if (containerPresent && !existingServers) {
    return {
      exact: false,
      customized: false,
      malformed: mentionsVispServer(current),
    };
  }
  const existing = existingServers?.[MCP_SERVER_NAME];
  return {
    exact: existing !== undefined && isDeepStrictEqual(existing, shape.entry),
    customized: existing !== undefined && !isDeepStrictEqual(existing, shape.entry),
    malformed: false,
  };
}

function parseConfig(text: string): McpConfig | undefined {
  try {
    return objectRecord(JSON.parse(stripJsonCommentsAndTrailingCommas(text)));
  } catch {
    // Rewriting a file we cannot parse would discard whatever it holds.
    return undefined;
  }
}

function stripJsonCommentsAndTrailingCommas(source: string): string {
  let clean = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"' && !isEscaped(source, i)) quoted = !quoted;
    if (!quoted && char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        clean += " ";
        i++;
      }
      clean += "\n";
      continue;
    }
    if (!quoted && char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) return source;
      clean += source.slice(i, end + 2).replace(/[^\n]/gu, " ");
      i = end + 1;
      continue;
    }
    clean += char;
  }
  return clean.replace(/,\s*(?=[}\]])/gu, (match, offset: number) => {
    return insideString(clean, offset) ? match : match.replace(",", " ");
  });
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; source[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

function insideString(source: string, offset: number): boolean {
  let quoted = false;
  for (let i = 0; i < offset; i++) if (source[i] === '"' && !isEscaped(source, i)) quoted = !quoted;
  return quoted;
}

function parseConfigText(current: string | undefined): McpConfig | "malformed" {
  if (current === undefined || current.trim() === "") return {};
  return parseConfig(current) ?? "malformed";
}

function mentionsVispServer(current: string | undefined): boolean {
  return current !== undefined && /["']visp["']\s*:/u.test(current);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatConfig(config: McpConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
