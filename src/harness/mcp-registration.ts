import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Harness, PRODUCT_NAME } from "../core/constants.js";
import { RecoveringProjectFileSystem } from "../core/file-transaction.js";
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
export const MCP_SERVER_NAME = PRODUCT_NAME;
export { CODEX_CONFIG_FILE } from "./codex-mcp-registration.js";

export type RegistrationStatus = "added" | "current" | "customized" | "replaced" | "malformed";

type McpConfig = Record<string, unknown>;

const MCP_JSON_ENTRY = {
  command: PRODUCT_NAME,
  args: ["serve", "--mcp"],
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
  return harness === "opencode"
    ? { file: OPENCODE_CONFIG_FILE, container: "mcp", entry: OPENCODE_ENTRY }
    : { file: MCP_CONFIG_FILE, container: "mcpServers", entry: MCP_JSON_ENTRY };
}

export function mcpConfigFile(harness: Harness): string {
  if (harness === "codex") return CODEX_CONFIG_FILE;
  return registrationShape(harness).file;
}

export async function registerMcpServer(
  root: string,
  force: boolean,
  harness: Harness = "claude-code",
): Promise<Result<RegistrationStatus>> {
  const path = join(root, mcpConfigFile(harness));
  const files = new RecoveringProjectFileSystem(root);

  const current = await files.readTextIfExists(path);
  if (!current.ok) return current;

  const planned = planMcpRegistration(current.value, force, harness);
  if (!planned.ok) return planned;
  if (planned.value.content === undefined) return ok(planned.value.status);
  const written = await files.writeTextAtomic(path, planned.value.content);
  return written.ok ? ok(planned.value.status) : written;
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
    if (!parsed) return replacementPlan(shape, force);
    config = parsed;
  }

  const containerPresent = Object.hasOwn(config, shape.container);
  const existingServers = objectRecord(config[shape.container]);
  if (containerPresent && !existingServers) return replacementPlan(shape, force, config);

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
    return objectRecord(JSON.parse(text));
  } catch {
    // Rewriting a file we cannot parse would discard whatever it holds.
    return undefined;
  }
}

function parseConfigText(current: string | undefined): McpConfig | "malformed" {
  if (current === undefined || current.trim() === "") return {};
  return parseConfig(current) ?? "malformed";
}

function mentionsVispServer(current: string | undefined): boolean {
  return current !== undefined && /["']visp["']\s*:/u.test(current);
}

function replacementPlan(
  shape: RegistrationShape,
  force: boolean,
  config?: McpConfig,
): Result<PlannedMcpRegistration> {
  if (!force) return ok({ status: "malformed" });

  return ok({
    status: "replaced",
    content: formatConfig({
      ...(config ?? {}),
      [shape.container]: { [MCP_SERVER_NAME]: shape.entry },
    }),
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatConfig(config: McpConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
