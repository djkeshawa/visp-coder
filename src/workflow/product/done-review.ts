import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { outcomeStatuses } from "./assessment.js";
import { cancelledExecution } from "./check-lifecycle.js";
import { type ProductCriticHost, runProductCritic } from "./critic.js";
import { type ReviewerCapacity, reviewerCapacity } from "./critic-capacity.js";
import { codexExecCriticHost, configuredCriticLauncher } from "./critic-exec.js";
import { hasPendingCriticReview } from "./critic-policy.js";
import { type ProductVerification, runProductAccept, runProductDone } from "./evidence.js";
import { outstandingFeedback } from "./findings.js";
import { type AcceptanceProgress, acceptanceProgress } from "./independent-tests.js";
import { closedSlice } from "./model.js";
import type { PinnedDispute } from "./pinned-dispute-model.js";
import {
  type DisputeInput,
  type DisputeOutcome,
  type DisputeState,
  disputedFailure,
  disputeInput,
  disputeState,
  failingPinned,
  fileDisputes,
  type PinnedTestsReport,
  pinnedTestsReport,
  ranPinned,
  refreshDisputes,
  rulingCurrent,
} from "./pinned-disputes.js";
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
  /** Disputes of failing pinned tests: what was filed, the rulings, how to dispute. */
  readonly pinnedTests?: PinnedTestsReport;
  readonly critic?: DoneCriticSummary;
  readonly next?: ProductNext;
};

interface ReviewSelection extends ProductSelection {
  readonly feature: string;
  readonly task?: string;
  /** Running the same command again is cheap and safe: an inline review may wait for it. */
  readonly rerunnable?: boolean;
}

/** Returned reviews took 48 s at the median and 75 s at p90; a review with less left is cut off. */
const MIN_INLINE_REVIEW_MS = 75_000;
/** Slack so a suite cut off at its reserved deadline still leaves a full review window. */
const INFORMATIONAL_MARGIN_MS = 2000;
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
  const dispute = disputeInput(options);
  if (!dispute.ok) return dispute;
  const deadline = callDeadline(options, waitMs);
  const checked = await runProductDone(workspace, options);
  if (!checked.ok) return checked;
  const { feature } = checked.value;
  const rerunnable = rerunnableReview(waitMs);
  const progressDeadline = informationalDeadline(deadline, !!startReview && rerunnable);
  const progress = await acceptanceProgress(
    workspace,
    feature,
    checked.value.executions.map((execution) => execution.check),
    { ...options, deadline: progressDeadline },
  );
  if (options.signal?.aborted) return cancelledExecution();
  const pinned = await pinnedView(workspace, "done", dispute.value, checked.value);
  if (!pinned.ok) return pinned;
  const { state } = pinned.value;
  const done = ok({
    ...(progress.length ? { ...checked.value, acceptanceTests: progress } : checked.value),
    ...pinned.value.initial,
  });
  if (!startReview) return done;
  const { record, owed } = await readForReview(
    workspace,
    feature,
    done.value.task,
    done.value.subjectDigest,
  );
  if (!checksPassed(done.value, state, owed)) return done;
  const skipped = await reviewNotNeeded(
    workspace,
    feature,
    done.value.task,
    done.value.subjectDigest,
    state.pending,
    record,
  );
  if (skipped) return ok({ ...done.value, critic: skipped });
  const critic = await launchReview(workspace, options, deadline, startReview, {
    feature,
    // `done` reuses passed checks, so running it again costs little; `accept` re-runs them all.
    rerunnable,
    ...(done.value.closed || !done.value.task ? {} : { task: done.value.task }),
  });
  if (options.signal?.aborted) return cancelledExecution();
  const next = critic.running ? waitingNext(feature) : await runProductNext(workspace, { feature });
  return ok({
    ...done.value,
    ...(await pinned.value.refreshed()),
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
): Promise<
  Result<
    ProductVerification & { readonly critic?: DoneCriticSummary; pinnedTests?: PinnedTestsReport }
  >
> {
  const dispute = disputeInput(options);
  if (!dispute.ok) return dispute;
  const deadline = callDeadline(options, waitMs);
  const accepted = await runProductAccept(workspace, options);
  if (!accepted.ok) return accepted;
  const { feature } = accepted.value;
  const pinned = await pinnedView(workspace, "accept", dispute.value, accepted.value);
  if (!pinned.ok) return pinned;
  const initial = { ...accepted.value, ...pinned.value.initial };
  if (accepted.value.passed || !startReview || !checksPassed(accepted.value, pinned.value.state))
    return ok(initial);
  if (options.signal?.aborted) return cancelledExecution();
  const critic = await launchReview(workspace, options, deadline, startReview, { feature });
  if (critic.running || !critic.reviewed) return ok({ ...initial, critic });
  if (options.signal?.aborted) return cancelledExecution();
  const again = await runProductAccept(workspace, { ...options, reusePassed: true });
  if (!again.ok) return again;
  return ok({ ...again.value, critic, ...(await pinned.value.refreshed()) });
}

interface PinnedView {
  /** Where the disputes stand; pending ones do not stop the reviewer from launching. */
  readonly state: DisputeState;
  readonly initial: { pinnedTests?: PinnedTestsReport };
  /** After a review: this call's filing outcomes with where each dispute stands now. */
  refreshed(): Promise<{ pinnedTests?: PinnedTestsReport }>;
}

/**
 * Brings open disputes up to the failing run just observed, files this call's disputes
 * against it, and reports on them. Only the pinned suite run as a blocking check counts:
 * on earlier slices it is informational and nothing can be disputed.
 */
async function pinnedView(
  workspace: WorkspaceState,
  command: "done" | "accept",
  dispute: DisputeInput | undefined,
  verification: ProductVerification,
): Promise<Result<PinnedView>> {
  const { feature } = verification;
  const failing = failingPinned(verification.executions);
  if (ranPinned(verification.executions)) {
    const refreshed = await refreshDisputes(
      workspace,
      feature,
      failing,
      verification.subjectDigest,
    );
    if (!refreshed.ok) return refreshed;
  }
  // Whether VISP's reviewer can still rule matters to a failing pinned test and to a dispute.
  const capacity = async (): Promise<ReviewerCapacity> =>
    dispute !== undefined ||
    failing.length > 0 ||
    (await disputeState(workspace, feature)).all.some(isOpen)
      ? reviewerCapacity(
          workspace,
          feature,
          verification.subjectDigest,
          verification.closed || !verification.task ? undefined : verification.task,
        )
      : { available: true };
  const filed = dispute
    ? await fileDisputes(
        workspace,
        feature,
        dispute,
        failing,
        verification.subjectDigest,
        await capacity(),
      )
    : undefined;
  if (filed && !filed.ok) return filed;
  const report = async (outcomes?: readonly DisputeOutcome[]) =>
    pinnedTestsReport(workspace, feature, {
      ...(outcomes ? { filed: outcomes } : {}),
      failing: failing.length > 0,
      command,
      failures: failing,
      capacity: await capacity(),
    });
  const wrap = (pinnedTests: PinnedTestsReport | undefined) => (pinnedTests ? { pinnedTests } : {});
  const initial = wrap(await report(filed?.value));
  return ok({
    state: await disputeState(workspace, feature),
    initial,
    refreshed: async () => wrap(await report(filed?.value)),
  });
}

const isOpen = (entry: PinnedDispute) => entry.status === "open";

/** Starts the review and, when it is still running, holds the call for its result. */
async function launchReview(
  workspace: WorkspaceState,
  options: ProductSelection,
  deadline: number | undefined,
  startReview: ReviewStarter,
  selection: { feature: string; task?: string; rerunnable?: boolean },
): Promise<DoneCriticSummary> {
  await options.onProgress?.({
    check: "review",
    status: "starting; run visp next if still pending",
  });
  const critic = await startReview(workspace, { signal: options.signal, deadline, ...selection });
  // Weak workers kept editing while a review ran, and the changed source discarded it.
  // Holding `done` until the review returns delivers findings in the same step.
  if (
    critic.running &&
    !(await pendingReview(workspace, selection.feature, deadline ?? Date.now(), options))
  )
    return summarize(
      await runProductCritic(workspace, { operation: "status", feature: selection.feature }),
    );
  return critic;
}

/** The record after `done`, and whether the slice owes a required review. */
async function readForReview(
  workspace: WorkspaceState,
  feature: string,
  task: string | undefined,
  subject: string,
) {
  const loaded = await readProductRecord(workspace, { feature });
  const record = loaded.ok ? loaded.value : undefined;
  return { record, owed: !!record && !!task && reviewOwed(record, task, subject) };
}

/**
 * Running `done` again is cheap only where a review can ever fit in the call: the MCP wait is
 * shorter than a review, so there it starts with whatever time is left.
 */
function rerunnableReview(waitMs: number): boolean {
  return waitMs === 0 || waitMs >= MIN_INLINE_REVIEW_MS;
}

/** The informational pinned suite of a middle slice must not eat the time the review needs. */
function informationalDeadline(deadline: number | undefined, reserve: boolean) {
  return reserve && deadline !== undefined
    ? deadline - MIN_INLINE_REVIEW_MS - INFORMATIONAL_MARGIN_MS
    : deadline;
}

function callDeadline(options: ProductSelection, waitMs: number) {
  return options.deadline ?? (waitMs > 0 ? Date.now() + waitMs : undefined);
}

/**
 * After a review with no failed assessment and no required open finding, another review of a
 * middle slice rarely found anything in weak-worker runs and cost 1–2 minutes each.
 * The slice that completes the feature is always reviewed.
 */
async function reviewNotNeeded(
  workspace: WorkspaceState,
  feature: string,
  task: string | undefined,
  subject: string,
  pending: readonly PinnedDispute[],
  record: ProductRecord | undefined,
): Promise<DoneCriticSummary | undefined> {
  // A dispute is decided only by a review; once it has ruled on this exact source, another
  // review of it would find nothing new.
  if (pending.length) return undefined;
  if (await rulingCurrent(workspace, feature, subject))
    return {
      reviewed: false,
      findings: [],
      reason: "The independent review already ruled on this exact source",
    };
  if (!record || !task) return undefined;
  if (!skippableReview(record, task, subject)) return undefined;
  return {
    reviewed: false,
    findings: [],
    reason:
      "The previous independent review found no required problems; the next review runs when the last slice is done",
  };
}

/**
 * The slice has a mandatory outcome that needs a review (`reviewRequired`, or an experience
 * outcome) and no satisfied assessment yet. Only the reviewer can supply it, so it is never
 * skipped, and it must be able to launch even when the slice has no check to run.
 */
export function reviewOwed(record: ProductRecord, task: string, subject: string): boolean {
  const slice = record.brief.slices.find((entry) => entry.id === task);
  return (
    !!slice &&
    outcomeStatuses(record, subject, slice).some(
      (entry) => entry.priority === "must" && entry.requiredReview && entry.review !== "satisfied",
    )
  );
}

/** A clean previous review, a slice that does not complete the feature, and no required review owed. */
export function skippableReview(record: ProductRecord, task: string, subject: string): boolean {
  const { brief, state } = record;
  const last = state.reviews.at(-1);
  if (!last?.reviewer?.model) return false;
  const clean =
    last.assessments.every((assessment) => assessment.status !== "failed") &&
    !outstandingFeedback(record).some((finding) => finding.required && finding.phase === "product");
  const completesFeature = brief.slices.every(
    (slice) => slice.id === task || closedSlice(state.slices[slice.id]?.status),
  );
  return clean && !completesFeature && !reviewOwed(record, task, subject);
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
  return async (workspace, selection) => {
    const left = selection.deadline === undefined ? undefined : selection.deadline - Date.now();
    // A review that the deadline would abort still spends a call. Start it on the next run.
    if (selection.rerunnable && left !== undefined && left < MIN_INLINE_REVIEW_MS)
      return {
        reviewed: false,
        findings: [],
        reason: `Only ${Math.max(0, Math.round(left / 1000))} s of this command remain and VISP's reviewer needs about ${MIN_INLINE_REVIEW_MS / 1000} s, so it was not started and no review call was spent. Run the same command again: it starts the reviewer first.`,
      };
    return summarize(
      await runProductCritic(
        workspace,
        { operation: "review", feature: selection.feature, task: selection.task },
        launcher,
        deadlineSignal(selection.deadline, selection.signal),
      ),
    );
  };
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
function checksPassed(
  result: ProductVerification,
  disputes?: DisputeState,
  reviewOwed = false,
): boolean {
  // A pinned failure the worker has disputed in full must not keep the reviewer from ruling.
  const blocking = result.executions.filter(
    (execution) =>
      execution.status !== "passed" && !(disputes && disputedFailure(execution, disputes)),
  );
  if (blocking.length) return false;
  // A slice whose required review has no check to run still owes that review.
  return result.executions.length > 0 || result.passed || reviewOwed;
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

interface CriticResult {
  advice?: { summary?: string };
  findings?: { problem: string; nextCheck?: string; required?: boolean }[];
  callsRemaining?: number;
  gaps?: string[];
  /** Why an attempt ended without a review, as the critic recorded it. */
  reason?: string;
  stopped?: string;
  lifecycle?: { acceptedReview?: boolean; status?: string };
}

/** Why no review came back; a review still running is not a failure and needs no worker action. */
function unreviewedReason(value: CriticResult): string {
  const given = [value.reason, ...(value.gaps ?? [])].filter(Boolean).join("; ");
  if (given) return given;
  return value.stopped?.startsWith("review-in-progress") || value.lifecycle?.status === "pending"
    ? RUNNING_REASON
    : "The critic did not review";
}

const RUNNING_REASON = "VISP's reviewer is still running. Wait: run visp next.";

function summarize(result: Result<unknown>): DoneCriticSummary {
  if (!result.ok)
    return {
      reviewed: false,
      findings: [],
      reason: result.error.message.startsWith("review-in-progress")
        ? RUNNING_REASON
        : result.error.message,
    };
  const value = result.value as CriticResult;
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
    ...(reviewed ? {} : { reason: unreviewedReason(value) }),
  };
}
