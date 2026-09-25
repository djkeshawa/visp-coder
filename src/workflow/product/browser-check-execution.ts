import type { Result } from "../../core/result.js";
import {
  type PreparedProductCapture,
  prepareProductCapture,
} from "../evidence/product-capture-execution.js";
import type { WorkspaceState } from "../state.js";
import type { ExecutedProductCheck, ExecutionIdentity } from "./check-execution.js";
import { browserEnvironmentIdentity, failedBrowserCapability } from "./environment.js";
import type { ProductCheck, ProductState } from "./model.js";
import type { ProductRecord } from "./store.js";

/** Browser startup caching, capture execution and receipt construction share one boundary. */
export async function executeBrowserCheck(
  workspace: WorkspaceState,
  record: ProductRecord,
  command: Extract<ProductCheck["command"], { kind: "browser-journey" }>,
  base: ExecutionIdentity,
  retryEnvironment: boolean,
): Promise<ExecutedProductCheck> {
  const environmentDigest = await browserEnvironmentIdentity(workspace.paths.root);
  const cached = record.state.browserCapability;
  if (
    !retryEnvironment &&
    cached?.status === "unavailable" &&
    cached.environment === environmentDigest
  )
    return {
      execution: {
        ...base,
        environmentDigest,
        reusedEnvironmentFailure: true,
        provenance: "supervisor-reused",
        assertions: "runner-observed",
        status: "environment-failed",
        exitCode: -1,
        durationMs: 0,
        output: cached.detail,
      },
      state: record.state,
      mutations: [],
    };
  const started = Date.now();
  const captured = await prepareProductCapture(workspace, record, {
    journey: command.journey,
    task: base.task,
  });
  const checked = browserExecution(base, record.state, captured, Date.now() - started);
  const startupFailed = !captured.ok && captured.error.details?.gap === "browser-unavailable";
  return {
    ...checked,
    execution: { ...checked.execution, environmentDigest },
    state: {
      ...checked.state,
      browserCapability: startupFailed
        ? failedBrowserCapability(environmentDigest, checked.execution.output)
        : captured.ok
          ? {
              version: 1,
              environment: environmentDigest,
              checkedAt: new Date().toISOString(),
              status: "ready",
              kind: "startup-capture",
              detail:
                "Browser started for the recorded journey; assess its operations and results separately.",
            }
          : checked.state.browserCapability,
    },
  };
}

function browserExecution(
  base: ExecutionIdentity,
  state: ProductState,
  captured: Result<PreparedProductCapture>,
  durationMs: number,
): ExecutedProductCheck {
  if (!captured.ok)
    return {
      execution: {
        ...base,
        assertions: "runner-observed",
        status: "environment-failed",
        exitCode: -1,
        durationMs,
        output: captured.error.message.slice(-8000),
      },
      state,
      mutations: [],
    };
  const { result } = captured.value;
  const status =
    result.status === "completed"
      ? "passed"
      : result.failure?.kind === "behavior"
        ? "failed"
        : "environment-failed";
  return {
    execution: {
      ...base,
      subjectDigest: captured.value.subjectDigest,
      status,
      assertions: "runner-observed",
      captureRunId: result.runId,
      exitCode: { passed: 0, failed: 1, "environment-failed": -1 }[status],
      durationMs,
      output: JSON.stringify(result).slice(-8000),
    },
    state: captured.value.state,
    mutations: captured.value.mutations,
  };
}
