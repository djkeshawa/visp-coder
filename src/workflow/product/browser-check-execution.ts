import { redactText } from "../../core/redaction.js";
import type { Result } from "../../core/result.js";
import {
  type PreparedProductCapture,
  type ProductCaptureResult,
  prepareProductCapture,
} from "../evidence/product-capture-execution.js";
import { productJourneyKey } from "../evidence/product-journey.js";
import type { WorkspaceState } from "../state.js";
import { browserFailureRecovery } from "./browser-recovery.js";
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
  signal?: AbortSignal,
  timeoutMs?: number,
  reuseCapture = false,
): Promise<ExecutedProductCheck> {
  const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const browserSignal = timeout ? AbortSignal.any([timeout, ...(signal ? [signal] : [])]) : signal;
  const result = await runBrowserCheck(
    workspace,
    record,
    command,
    base,
    retryEnvironment,
    browserSignal,
    reuseCapture,
  );
  return timeout?.aborted && !signal?.aborted
    ? {
        ...result,
        execution: {
          ...result.execution,
          status: "timed-out",
          output: `${result.execution.output}\nVISP: check timed out; inspect the journey and its timeoutMs budget.`,
        },
      }
    : result;
}

async function runBrowserCheck(
  workspace: WorkspaceState,
  record: ProductRecord,
  command: Extract<ProductCheck["command"], { kind: "browser-journey" }>,
  base: ExecutionIdentity,
  retryEnvironment: boolean,
  signal?: AbortSignal,
  reuseCapture = false,
): Promise<ExecutedProductCheck> {
  const environmentDigest = await browserEnvironmentIdentity(workspace.paths.root);
  const prior = reuseCapture
    ? reusableRun(
        record.state.captureRuns,
        base.subjectDigest,
        productJourneyKey(command.journey, base.task),
      )
    : undefined;
  if (prior)
    return {
      execution: {
        ...base,
        environmentDigest,
        provenance: "supervisor-reused",
        assertions: "runner-observed",
        status: "passed",
        captureRunId: prior.id,
        exitCode: 0,
        durationMs: 0,
        output: `Reused completed capture ${prior.id} for the same subject and journey`,
      },
      state: record.state,
      mutations: [],
    };
  const cached = record.state.browserCapability;
  if (
    !retryEnvironment &&
    cached?.status === "unavailable" &&
    cached.kind === "missing-browser" &&
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
    signal,
  });
  const checked = browserExecution(
    base,
    record.state,
    captured,
    Date.now() - started,
    command.journey.url,
  );
  const startupFailed = !captured.ok && captured.error.details?.gap === "browser-unavailable";
  return {
    ...checked,
    execution: {
      ...checked.execution,
      output: redactText(checked.execution.output, { root: workspace.paths.root }),
      environmentDigest,
    },
    state: {
      ...checked.state,
      browserCapability: startupFailed
        ? failedBrowserCapability(
            environmentDigest,
            redactText(checked.execution.output, { root: workspace.paths.root }),
            !captured.ok ? captured.error.details?.browserFailureKind : undefined,
          )
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

function reusableRun(
  runs: readonly unknown[],
  subject: string,
  journeyKey: string,
): { id: string } | undefined {
  return runs
    .flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const run = candidate as Record<string, unknown>;
      return typeof run.id === "string" &&
        run.provenance === "runner-executed" &&
        run.status === "completed" &&
        run.subjectDigest === subject &&
        run.journeyKey === journeyKey
        ? [{ id: run.id }]
        : [];
    })
    .at(-1);
}

function browserExecution(
  base: ExecutionIdentity,
  state: ProductState,
  captured: Result<PreparedProductCapture>,
  durationMs: number,
  url: string,
): ExecutedProductCheck {
  if (!captured.ok)
    return {
      execution: {
        ...base,
        assertions: "runner-observed",
        status: "environment-failed",
        exitCode: -1,
        durationMs,
        output: [captured.error.message, captured.error.recovery]
          .filter(Boolean)
          .join("\n")
          .slice(-8000),
      },
      state,
      mutations: [],
    };
  const { result } = captured.value;
  // A wait-for that never observes its state ends the journey as timed out with a behavior
  // failure: that is the product failing, not the check running out of time.
  const status =
    result.status === "completed"
      ? "passed"
      : result.failure?.kind === "behavior"
        ? "failed"
        : result.status === "timed-out"
          ? "timed-out"
          : "environment-failed";
  return {
    execution: {
      ...base,
      subjectDigest: captured.value.subjectDigest,
      status,
      assertions: "runner-observed",
      captureRunId: result.runId,
      exitCode: { passed: 0, failed: 1, "environment-failed": -1, "timed-out": -1 }[status],
      durationMs,
      output: [
        browserCheckSummary(result),
        browserFailureRecovery(result.failure?.message ?? "", url),
      ]
        .filter(Boolean)
        .join("\n")
        .slice(-8000),
    },
    state: captured.value.state,
    mutations: captured.value.mutations,
  };
}

export function browserCheckSummary(result: ProductCaptureResult): string {
  return JSON.stringify({
    status: result.status,
    ...(result.failure
      ? {
          failure: {
            kind: result.failure.kind,
            message: result.failure.message.slice(0, 2000),
            actionIndex: result.failure.actionIndex,
          },
        }
      : {}),
    runId: result.runId,
    captures: result.captures.map((capture) => capture.id),
  });
}
