import { adapterFor, object } from "./adapters.js";
import type { EventJournal } from "./artifacts.js";
import type { NormalizedUsage, RunnerSpec, RunnerStatus } from "./contracts.js";
import type { FeedbackLoopSummary } from "./loop-contracts.js";
import { executeStream, type StreamResult } from "./process.js";
import { type HostObservations, HostStreamState } from "./stream-state.js";

export interface HostTurnResult {
  readonly feedbackLoop?: FeedbackLoopSummary;
  readonly status: RunnerStatus;
  readonly exitCode: number | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage[];
  readonly estimatedUsd: number | null;
  readonly diagnostics: string[];
  readonly stderr: string;
  readonly message: string;
  readonly observations: HostObservations;
}

export async function runHostTurn(
  spec: RunnerSpec,
  options: {
    worktree: string;
    journal: EventJournal;
    prompt: string;
    sessionId?: string;
    signal?: AbortSignal;
  },
): Promise<HostTurnResult> {
  const state = new HostStreamState(spec, options.journal, options.sessionId);
  let message = "";
  const execution = await executeStream({
    file: spec.host.executable,
    args: adapterFor(spec.host.kind).arguments(spec, options.sessionId),
    cwd: options.worktree,
    input: options.prompt,
    timeoutMs: spec.budget.maxDurationMs,
    signal: options.signal,
    onLine: (line) => {
      const stop = state.accept(line);
      const text = finalMessage(JSON.parse(line));
      if (text !== undefined) message = text.slice(0, 128_000);
      return stop;
    },
  });
  state.finish(execution);
  return {
    status: turnStatus(execution, state),
    exitCode: execution.exitCode,
    sessionId: state.sessionId,
    usage: state.usage,
    estimatedUsd: state.estimatedUsd,
    diagnostics: state.diagnostics,
    stderr: execution.stderr,
    message,
    observations: state.observations,
  };
}

function finalMessage(row: Record<string, unknown>): string | undefined {
  if (row.type === "result" && typeof row.result === "string") return row.result;
  if (row.type !== "item.completed" || !row.item || typeof row.item !== "object") return undefined;
  const item = object(row.item, "message item");
  return item.type === "agent_message" && typeof item.text === "string" ? item.text : undefined;
}

function turnStatus(execution: StreamResult, state: HostStreamState): RunnerStatus {
  if (["cancelled", "timed-out", "budget-exceeded"].includes(execution.reason))
    return execution.reason as "cancelled" | "timed-out" | "budget-exceeded";
  return execution.reason === "exited" &&
    execution.exitCode === 0 &&
    state.terminal === "completed" &&
    !state.diagnostics.length
    ? "completed"
    : "failed";
}
