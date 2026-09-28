import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { cancelledExecution } from "./check-lifecycle.js";
import { type ProductCriticHost, runProductCritic } from "./critic.js";
import { codexExecCriticHost, configuredCriticLauncher } from "./critic-exec.js";
import { hasPendingCriticReview } from "./critic-policy.js";
import { type ProductVerification, runProductAccept, runProductDone } from "./evidence.js";
import { outstandingFeedback } from "./findings.js";
import { type AcceptanceProgress, acceptanceProgress } from "./independent-tests.js";
import { closedSlice } from "./model.js";
import type { ProductNext } from "./status.js";
import { runProductNext } from "./status.js";
import { type ProductRecord, type ProductSelection, readProductRecord } from "./store.js";

export interface DoneCriticSummary {
  readonly reviewed: boolean;
  /** The reviewer is still running in the background; `visp next` waits for it. */
  readonly running?: boolean;
  readonly summary?: string;
  readonly findings: readonly { problem: string; nextCheck?: string; required?: boolean }[];
  readonly callsRemaining?: number;
  /** Why no review happened: no applicable evidence, exhausted budget, or a failed launch. */
  readonly reason?: string;
}
export type ProductDoneReviewed = ProductVerification & {
  readonly acceptanceTests?: readonly AcceptanceProgress[];
  readonly critic?: DoneCriticSummary;
  readonly next?: ProductNext;
};

interface ReviewSelection extends ProductSelection {
  readonly feature: string;
  readonly task?: string;
}
/** Starts an independent review of the selection and reports what happened so far. */
export type ReviewStarter = (
  workspace: WorkspaceState,
  selection: ReviewSelection,
) => Promise<DoneCriticSummary>;

/**
 * `done`, then independent review when VISP may launch the reviewer. A worker that never
 * orchestrates delegation still gets the critic's findings as its next repair step. The
 * critic's own reservation, budget and freshness rules decide whether a call is spent.
 */
export async function runProductDoneReviewed(
  workspace: WorkspaceState,
  options: ProductSelection,
  startReview?: ReviewStarter,
  waitMs = 0,
): Promise<Result<ProductDoneReviewed>> {
  const deadline = callDeadline(options, waitMs);
  const checked = await runProductDone(workspace, options);
  if (!checked.ok) return checked;
  const progress = await acceptanceProgress(
    workspace,
    checked.value.feature,
    checked.value.executions.map((execution) => execution.check),
    { ...options, deadline },
  );
  if (options.signal?.aborted) return cancelledExecution();
  const done = ok(
    progress.length ? { ...checked.value, acceptanceTests: progress } : checked.value,
  );
  if (!startReview || !checksPassed(done.value)) return done;
  const skipped = await reviewNotNeeded(workspace, done.value.feature, done.value.task);
  if (skipped) return ok({ ...done.value, critic: skipped });
  const { feature } = done.value;
  await options.onProgress?.({
    check: "review",
    status: "starting; run visp next if still pending",
  });
  let critic = await startReview(workspace, {
    signal: options.signal,
    deadline,
    feature,
    ...(done.value.closed || !done.value.task ? {} : { task: done.value.task }),
  });
  // Weak workers kept editing while a review ran, and the changed source discarded it.
  // Holding `done` until the review returns delivers findings in the same step.
  if (critic.running && !(await pendingReview(workspace, feature, deadline ?? Date.now(), options)))
    critic = summarize(await runProductCritic(workspace, { operation: "status", feature }));
  if (options.signal?.aborted) return cancelledExecution();
  const next = critic.running ? waitingNext(feature) : await runProductNext(workspace, { feature });
  return ok({
    ...done.value,
    critic,
    ...(next.ok ? { next: next.value, nextCommand: next.value.command } : {}),
  });
}

/**
 * `accept`, with VISP's reviewer assessing the assembled product first when acceptance
 * lacks a current assessment. Weak workers were sent to the host review protocol here and
 * stopped. Checks that fail are fixed first; a spent budget leaves acceptance unchanged.
 */
export async function runProductAcceptReviewed(
  workspace: WorkspaceState,
  options: ProductSelection,
  startReview?: ReviewStarter,
  waitMs = 0,
): Promise<Result<ProductVerification & { readonly critic?: DoneCriticSummary }>> {
  const deadline = callDeadline(options, waitMs);
  const accepted = await runProductAccept(workspace, options);
  if (!accepted.ok || accepted.value.passed || !startReview || !checksPassed(accepted.value))
    return accepted;
  const { feature } = accepted.value;
  if (options.signal?.aborted) return cancelledExecution();
  await options.onProgress?.({
    check: "review",
    status: "starting; run visp next if still pending",
  });
  let critic = await startReview(workspace, { feature, signal: options.signal, deadline });
  if (critic.running && !(await pendingReview(workspace, feature, deadline ?? Date.now(), options)))
    critic = summarize(await runProductCritic(workspace, { operation: "status", feature }));
  if (critic.running || !critic.reviewed) return ok({ ...accepted.value, critic });
  if (options.signal?.aborted) return cancelledExecution();
  const again = await runProductAccept(workspace, { ...options, reusePassed: true });
  return again.ok ? ok({ ...again.value, critic }) : again;
}

function callDeadline(options: ProductSelection, waitMs: number) {
  return options.deadline ?? (waitMs > 0 ? Date.now() + waitMs : undefined);
}

/**
 * After a review with no failed assessment and no open finding, another review of a
 * middle slice rarely found anything in weak-worker runs and cost 1–2 minutes each.
 * The slice that completes the feature is always reviewed.
 */
async function reviewNotNeeded(
  workspace: WorkspaceState,
  feature: string,
  task: string | undefined,
): Promise<DoneCriticSummary | undefined> {
  const loaded = await readProductRecord(workspace, { feature });
  if (!loaded.ok || !task) return undefined;
  if (!skippableReview(loaded.value, task)) return undefined;
  return {
    reviewed: false,
    findings: [],
    reason:
      "The previous independent review found no problems; the next review runs when the last slice is done",
  };
}

/** A clean previous review, and a slice that does not complete the feature. */
export function skippableReview(record: ProductRecord, task: string): boolean {
  const { brief, state } = record;
  const last = state.reviews.at(-1);
  if (!last?.reviewer?.model) return false;
  const clean =
    last.assessments.every((assessment) => assessment.status !== "failed") &&
    !outstandingFeedback(record).some((finding) => finding.phase === "product");
  const completesFeature = brief.slices.every(
    (slice) => slice.id === task || closedSlice(state.slices[slice.id]?.status),
  );
  return clean && !completesFeature;
}

/**
 * `next`, after giving a running background review up to `waitMs` to return, so a worker
 * that simply asks what to do next receives the findings instead of an in-progress notice.
 */
export async function runProductNextAfterReview(
  workspace: WorkspaceState,
  options: ProductSelection,
  channel: "cli" | "mcp" = "cli",
): Promise<Result<ProductNext>> {
  const feature = options.feature ?? workspace.status?.activeFeature;
  if (
    feature &&
    (await pendingReview(
      workspace,
      feature,
      options.deadline ?? Date.now() + reviewWaitMs(workspace, channel),
      options,
    ))
  )
    return waitingNext(feature);
  return runProductNext(workspace, options);
}

/**
 * Reviews usually return in 40–100 s; weak workers asked once and stopped after a 30 s
 * wait. Polling uses the remaining whole-call budget: 100 s on CLI, 50 s on MCP.
 * Checks may need a longer host timeout; they consume this budget before review waits.
 */
const REVIEW_WAIT_MS = { cli: 100_000, mcp: 50_000 } as const;

/** How long `done` and `next` wait for a VISP-launched review on this channel. */
export function reviewWaitMs(workspace: WorkspaceState, channel: "cli" | "mcp"): number {
  return workspace.config.critic?.launch === "codex-exec" ? REVIEW_WAIT_MS[channel] : 0;
}

/** How `done` starts review for this project, or undefined when the host delegates it. */
export function configuredReviewStarter(
  workspace: WorkspaceState,
  channel: "cli" | "mcp" = "cli",
): ReviewStarter | undefined {
  if (workspace.config.critic?.launch !== "codex-exec") return undefined;
  // Codex's sandbox ends background processes when a shell command returns; reviews from a
  // Codex worker's CLI stayed pending forever. They run inside `visp done` there instead.
  if (channel === "cli" && workspace.config.harness === "codex")
    return inlineReview(
      configuredCriticLauncher(workspace) ?? codexExecCriticHost({ root: workspace.paths.root }),
    );
  // Bundled builds place the CLI entry beside this chunk; source runs review inline.
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  return existsSync(cli)
    ? backgroundReview(cli)
    : inlineReview(codexExecCriticHost({ root: workspace.paths.root }));
}

/** Run the review in this process; used where the caller outlives the reviewer. */
export function inlineReview(launcher: ProductCriticHost): ReviewStarter {
  return async (workspace, selection) =>
    summarize(
      await runProductCritic(
        workspace,
        { operation: "review", feature: selection.feature, task: selection.task },
        launcher,
        deadlineSignal(selection.deadline, selection.signal),
      ),
    );
}

/** The caller's signal, also aborted at `deadline` (epoch ms, possibly fractional). */
export function deadlineSignal(
  deadline: number | undefined,
  signal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (deadline === undefined) return signal;
  // AbortSignal.timeout accepts only whole milliseconds.
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now())));
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/**
 * Run the review in a detached VISP process that records its own result. Agent hosts
 * kill a long shell command or its process group when a turn ends; a review that lived
 * inside `done` died with it and stayed pending until its deadline.
 */
export function backgroundReview(cli: string, startupMs = 15_000): ReviewStarter {
  return async (workspace, selection) => {
    const log = join(await mkdtemp(join(tmpdir(), "visp-review-")), "review.json");
    const output = openSync(log, "w");
    const child = spawn(
      process.execPath,
      [
        cli,
        "--project",
        workspace.paths.root,
        "critic",
        "--dispatch",
        "--feature",
        selection.feature,
        ...(selection.task ? ["--task", selection.task] : []),
        "--json",
      ],
      { detached: true, stdio: ["ignore", output, output] },
    );
    closeSync(output);
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    child.unref();
    const deadline = Math.min(
      Date.now() + startupMs,
      selection.deadline ?? Number.POSITIVE_INFINITY,
    );
    while (Date.now() < deadline && !exited && !selection.signal?.aborted) {
      const pending = await hasPendingCriticReview(workspace, selection.feature);
      if (pending.ok && pending.value) return runningSummary();
      await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, {
        signal: selection.signal,
      }).catch(() => undefined);
    }
    if (!exited) return runningSummary();
    return summarizeEnvelope(await readFile(log, "utf8").catch(() => ""));
  };
}

function runningSummary(): DoneCriticSummary {
  return {
    reviewed: false,
    running: true,
    findings: [],
    summary:
      "Independent review is running (usually 1–2 minutes). Editing pauses until it returns. Run `visp next`; it waits for the findings.",
  };
}

function waitingNext(feature: string): Result<ProductNext> {
  return ok({
    action: "wait",
    feature,
    objective:
      "Independent review is still running. Run the command again to wait for its findings; editing pauses until it returns.",
    command: `visp next --feature ${feature}`,
    evidence: [],
    mayEdit: false,
  });
}

async function pendingReview(
  workspace: WorkspaceState,
  feature: string,
  deadline: number,
  options: ProductSelection,
) {
  let announced = false;
  for (;;) {
    const pending = await hasPendingCriticReview(workspace, feature);
    if (!pending.ok || !pending.value) return false;
    if (Date.now() >= deadline || options.signal?.aborted) return true;
    if (!announced) {
      await options.onProgress?.({ check: "review", status: "waiting for independent findings" });
      announced = true;
    }
    await delay(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, {
      signal: options.signal,
    }).catch(() => undefined);
  }
}

/**
 * Failing checks are cheaper to fix than to review. `done` may execute nothing new when
 * `verify` already passed the current source; a passed result still warrants review.
 */
function checksPassed(result: ProductVerification): boolean {
  if (result.executions.some((execution) => execution.status !== "passed")) return false;
  return result.executions.length > 0 || result.passed;
}

function summarizeEnvelope(text: string): DoneCriticSummary {
  try {
    const envelope = JSON.parse(text) as {
      ok: boolean;
      data?: unknown;
      error?: { message: string };
    };
    return envelope.ok
      ? summarize(ok(envelope.data))
      : { reviewed: false, findings: [], reason: envelope.error?.message ?? "Review failed" };
  } catch {
    return { reviewed: false, findings: [], reason: "The review process ended without a result" };
  }
}

function summarize(result: Result<unknown>): DoneCriticSummary {
  if (!result.ok) return { reviewed: false, findings: [], reason: result.error.message };
  const value = result.value as {
    lifecycle?: { acceptedReview?: boolean };
    advice?: { summary?: string };
    findings?: { problem: string; nextCheck?: string; required?: boolean }[];
    callsRemaining?: number;
    gaps?: string[];
  };
  const reviewed = value.lifecycle?.acceptedReview === true;
  return {
    reviewed,
    ...(value.advice?.summary ? { summary: value.advice.summary } : {}),
    findings: (value.findings ?? []).map(({ problem, nextCheck, required }) => ({
      problem,
      ...(nextCheck ? { nextCheck } : {}),
      ...(required !== undefined ? { required } : {}),
    })),
    ...(value.callsRemaining !== undefined ? { callsRemaining: value.callsRemaining } : {}),
    ...(reviewed ? {} : { reason: value.gaps?.join("; ") || "The critic did not review" }),
  };
}
