import { ok, type Result } from "../../core/result.js";
import { probeBrowserCapability } from "../../testing/browser-capability.js";
import type { WorkspaceState } from "../state.js";
import { isBrowserCheckCommand } from "./check-command.js";
import {
  type BrowserCapability,
  browserExecutionEnvironmentIdentity,
  environmentRecovery,
} from "./environment-model.js";
import { checksFor, type ProductBrief, type ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";

export { environmentRecovery } from "./environment-model.js";
export function needsBrowser(brief: ProductBrief, slice?: ProductSlice) {
  if (checksFor(brief, slice).some((check) => isBrowserCheckCommand(check.command))) return true;
  const outcomes = brief.outcomes.filter((entry) => !slice || slice.outcomes.includes(entry.id));
  const visual = outcomes.some(
    (entry) => entry.kind === "experience" || entry.expectations.some((item) => item.viewport),
  );
  // An empty check list must not defer a promised browser UI's capability check until delivery.
  // Native/CLI experience outcomes alone do not imply a Chrome requirement.
  const webIntent = /\b(?:browser|website|web\s+(?:app|game|page|site|interface))\b/i.test(
    [brief.originalRequest, brief.goal, slice?.goal].join("\n"),
  );
  const webScope = (slice ? [slice] : brief.slices).some((entry) =>
    entry.scope.allowed.some((path) => /\.(?:html?|jsx|tsx|vue|svelte)$/.test(path)),
  );
  return visual && (webIntent || webScope);
}

/** Hash environment inputs without exposing values. Source/brief edits are deliberately excluded. */
export async function browserEnvironmentIdentity(root: string) {
  return browserExecutionEnvironmentIdentity(root);
}

export async function checkBrowserEnvironment(
  root: string,
  previous?: BrowserCapability,
  retry = false,
) {
  const environment = await browserEnvironmentIdentity(root);
  if (!retry && previous?.environment === environment) return previous;
  const base = { version: 1 as const, environment, checkedAt: new Date().toISOString() };
  try {
    await probeBrowserCapability();
    return {
      ...base,
      status: "ready" as const,
      kind: "startup-capture" as const,
      detail:
        "An isolated blank page started and produced a valid image. Project URL access, real input, product quality and host image review still require the actual journey.",
    };
  } catch (cause) {
    return failedBrowserCapability(
      environment,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

export function failedBrowserCapability(environment: string, detail: string): BrowserCapability {
  return {
    version: 1,
    environment,
    checkedAt: new Date().toISOString(),
    status: "unavailable",
    kind: /ENOENT|not found/i.test(detail)
      ? "missing-browser"
      : /permission|permitted|sandbox/i.test(detail)
        ? "permissions"
        : "startup",
    detail: detail.slice(-4000),
  };
}

export function environmentNext(
  feature: string,
  task: string | undefined,
  evidence: string[],
  operation: "work" | "verify" = "work",
) {
  return {
    feature,
    ...(task ? { task } : {}),
    action: "understand" as const,
    objective:
      "Required execution environment is unavailable; recover the host capability before expanding this slice",
    command: `visp ${operation} --feature ${feature}${task ? ` --task ${task}` : ""} --retry-environment`,
    evidence,
    mayEdit: false,
    completion: "unresolved-environment" as const,
    recovery: environmentRecovery,
  };
}

export async function prepareWorkEnvironment(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  retry = false,
): Promise<Result<ProductRecord>> {
  if (!needsBrowser(record.brief, slice)) return ok(record);
  const capability = await checkBrowserEnvironment(
    workspace.paths.root,
    record.state.browserCapability,
    retry,
  );
  const current = { ...record, state: { ...record.state, browserCapability: capability } };
  // Startup capability is required for acceptance, not for useful scoped implementation.
  // The normal work transaction persists this gap together with its scope authorization.
  return ok(current);
}
