import { readFile } from "node:fs/promises";
import { z } from "zod";
import { browserExecutableIdentity } from "../../core/browser-executable.js";
import { productIdentityEnvironment } from "../../core/execution-environment.js";
import { hashValue } from "../../core/hash.js";

/** Derived capability observation, never acceptance evidence or authored intent. */
export const browserCapabilitySchema = z
  .object({
    version: z.literal(1),
    environment: z.string(),
    checkedAt: z.string(),
    status: z.enum(["ready", "unavailable"]),
    kind: z.enum(["startup-capture", "missing-browser", "permissions", "startup"]),
    detail: z.string(),
  })
  .strict();
export type BrowserCapability = z.infer<typeof browserCapabilitySchema>;

export interface SupportedHostCaptureInput {
  readonly feature?: string;
  readonly task?: string;
  readonly journey?: unknown;
  readonly replay?: string;
  readonly binary?: string;
}

/**
 * Keep a successful capture tied to the executable and host security context
 * that actually ran it. The no-binary form intentionally matches the default
 * identity used by the environment probe; a custom binary gets its own key.
 */
export async function browserExecutionEnvironmentIdentity(root: string, binary?: string) {
  const executable = await browserExecutableIdentity(binary);
  const security = await readFile("/proc/self/status", "utf8").then(
    (text) => text.split("\n").filter((line) => /^(Seccomp|NoNewPrivs|CapEff):/.test(line)),
    () => [],
  );
  return hashValue({
    version: 2,
    root,
    executable,
    node: process.execPath,
    uid: process.getuid?.(),
    security,
    environment: productIdentityEnvironment(),
  });
}

export function supportedHostCaptureOption(input: SupportedHostCaptureInput) {
  const args = {
    ...(input.feature ? { feature: input.feature } : {}),
    ...(input.task ? { task: input.task } : {}),
    ...(input.replay
      ? { replay: input.replay }
      : input.journey !== undefined
        ? { journey: input.journey }
        : {}),
    ...(input.binary ? { binary: input.binary } : {}),
  };
  return {
    transport: "mcp" as const,
    tool: "visp_capture" as const,
    arguments: args,
  };
}

export function supportedHostCaptureRecovery(input: SupportedHostCaptureInput) {
  const option = supportedHostCaptureOption(input);
  return {
    option,
    message:
      `If a supported VISP MCP host is available, call ${option.tool} with arguments ` +
      `${JSON.stringify(option.arguments)}. This is a host transport option, not a retry in the failed shell. Use it only in a supported context that can start the browser; do not repeat the failed transport unchanged. If unavailable, retain the browser gap.`,
  };
}

export const environmentRecovery =
  "Inspect the recorded execution error first. For a missing command, correct its executable/arguments or recover the installed tool; manual action descriptions belong in brief examples, not executable checks. For a browser permission failure, request the host's supported execution permission, then run --retry-environment in that approved context. On Codex, where exec_command exposes it, this means sandbox_permissions: require_escalated with a justification; it is a host tool argument, not a VISP flag. Retrying the same sandbox or changing Chrome aliases does not recover permission. If the host refuses, retain the gap. For a missing browser, select an installed binary via CHROME_BIN. Keep browser sandboxing enabled. A URL-policy refusal requires a permitted review surface or an explicit review gap, never a workaround.";
