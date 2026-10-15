import { vispError } from "../../../core/errors.js";
import { err, ok, type Result } from "../../../core/result.js";
import type { WorkspaceState } from "../../state.js";
import { createProductFeature } from "../feature-create.js";
import type { ProductFeatureOptions, ProductFeatureOutcome } from "../feature-model.js";
import { hostRequest } from "../host-prompts.js";
import { readProductRecord } from "../store.js";
import {
  executionRefusal,
  existingCode,
  hasFunctionalOutcome,
  launchedOnExistingCode,
  startingSourceDigest,
  testerApplies,
  testerLaunches,
} from "./independent-tests-mode.js";
import {
  type IndependentTestsRecord,
  type IndependentTestsSummary,
  sleep,
  type TestsStarter,
} from "./independent-tests-model.js";
import { isStale, readTestsRecord } from "./independent-tests-record.js";
import { mayRestartTester, writeIndependentTests } from "./independent-tests-run.js";
import { CLAUDE_EXISTING_CODE, configuredTester, testerCli } from "./tester-session.js";

/**
 * Called by `work` before authorization. Deliver existing tests and interpretation notes;
 * a background tester can pin its suite while the worker continues.
 */
export async function independentTestsBeforeWork(
  workspace: WorkspaceState,
  feature: string | undefined,
  starter: TestsStarter | undefined,
  waitMs: number,
): Promise<Result<IndependentTestsSummary | undefined>> {
  const loaded = await readProductRecord(workspace, feature ? { feature } : {});
  if (!loaded.ok) return ok(undefined);
  const { brief } = loaded.value;
  if (!hasFunctionalOutcome(brief)) return ok(undefined);
  const existing = await readTestsRecord(workspace, brief.feature);
  if (!existing.ok) return existing;
  let record = existing.value;
  // Workers waited 1–2 minutes here. Pinned tests are not part of a slice's contract, so
  // work proceeds and the tests are pinned whenever the tester finishes.
  if (!record) {
    if (!(await testerApplies(workspace, loaded.value))) return ok(undefined);
    if (!starter || !(await testerLaunches(workspace, loaded.value)))
      return ok(await skippedTester(workspace));
    const source = await startingSourceDigest(workspace, brief.feature, brief);
    if (!source.ok) return source;
    const started = await starter(workspace, brief.feature, waitMs);
    if (!started.ok) return started;
    record = started.value;
  }
  return ok(await summary(record));
}

/** `work --write-tests` and `--retry-tests`: the configured tester, or why VISP launches none. */
export async function writeConfiguredTests(
  workspace: WorkspaceState,
  feature: string,
  retryFailed: boolean,
): Promise<Result<IndependentTestsRecord>> {
  const tester = configuredTester(workspace);
  if (!tester)
    return err(vispError("CONFIG_INVALID", (await skippedTester(workspace)).reason ?? ""));
  return writeIndependentTests(workspace, feature, tester, retryFailed);
}

/** Why a feature that would get independent tests gets none, so the worker can say so. */
async function skippedTester(workspace: WorkspaceState): Promise<IndependentTestsSummary> {
  const critic = workspace.config.critic;
  const cli = testerCli(workspace);
  const reason = !cli
    ? critic?.launch === "codex-exec"
      ? "The independent tester requires critic.harness: codex"
      : critic?.launch === "claude-exec"
        ? "The independent tester requires critic.harness: claude-code"
        : "VISP launches its independent tester only with critic.launch: codex-exec or claude-exec, so no acceptance tests are written for this feature"
    : cli === "claude" && (await existingCode(workspace.paths.root))
      ? CLAUDE_EXISTING_CODE
      : `The independent tester needs the ${cli} CLI on PATH for this process`;
  return { status: "skipped", reason };
}

/**
 * `feature` starts the tester, which needs only the original request, so it writes while
 * the worker drafts the brief; `work` then usually finds the tests ready.
 */
export async function startIndependentTests(
  workspace: WorkspaceState,
  feature: string,
  starter: TestsStarter | undefined,
): Promise<void> {
  if (!starter) return;
  const loaded = await readProductRecord(workspace, { feature });
  const existing = await readTestsRecord(workspace, feature);
  if (!loaded.ok || !existing.ok || existing.value) return;
  if (await testerLaunches(workspace, loaded.value)) {
    const source = await startingSourceDigest(workspace, feature, loaded.value.brief);
    if (source.ok) await starter(workspace, feature, 0);
  }
}

/** `visp feature` without the tester: the source-brief check, then the feature. */
export async function createProductFeatureChecked(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
  starter: TestsStarter | undefined,
): Promise<Result<ProductFeatureOutcome>> {
  // A worker's one-line summary would become the only contract the tester and reviewer see.
  const recorded = await hostRequest(workspace, options.sourceBrief);
  if (starter && !options.sourceBrief?.trim() && !(recorded.ok && recorded.value))
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Pass the user's complete request, verbatim, as the source brief: the independent tester and reviewer judge the work against it alone",
        {
          recovery: `visp feature "${options.goal.replaceAll('"', "'").slice(0, 80)}" --source-brief - (pipe the complete request on stdin)`,
        },
      ),
    );
  return createProductFeature(workspace, options);
}

/** `visp feature`, then the tester in the background when VISP launches one. */
export async function createProductFeatureWithTests(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
  starter: TestsStarter | undefined,
): Promise<Result<ProductFeatureOutcome>> {
  const created = await createProductFeatureChecked(workspace, options, starter);
  if (!created.ok) return created;
  const refused = await startFeatureTester(workspace, created.value, starter);
  return refused ? ok({ ...created.value, testsNote: refused }) : created;
}

/**
 * The tester of a new feature; of the earlier one when the request was a repeat. Resolves to
 * the reason when VISP refused to restart it.
 */
async function startFeatureTester(
  workspace: WorkspaceState,
  created: ProductFeatureOutcome,
  starter: TestsStarter | undefined,
): Promise<string | undefined> {
  // A repeated request returns the earlier feature, which must still end with pinned tests.
  if (created.duplicateOf) return restartTester(workspace, created.duplicateOf, starter);
  await startIndependentTests(workspace, created.brief.feature, starter);
  return undefined;
}

/** How long `visp feature` waits for the tester's record before it prints. */
const RECORD_WAIT_MS = 3000;

/**
 * Starts the tester without waiting for it, so `visp feature` can print first. It waits only
 * until the tests record shows running (or the start settled), so that `visp work` in another command
 * finds a running tester instead of starting a second one. `finished` ends with the tester;
 * its failures are in the tests record, never thrown.
 */
export async function beginFeatureTester(
  workspace: WorkspaceState,
  created: ProductFeatureOutcome,
  starter: TestsStarter | undefined,
): Promise<{ readonly testsNote?: string; readonly finished: Promise<void> }> {
  const feature = created.duplicateOf ?? created.brief.feature;
  let settled = false;
  let refused: string | undefined;
  // The note is true only for a tester this process started and runs itself.
  let started = false;
  const watched: TestsStarter | undefined =
    starter &&
    Object.assign(
      (...args: Parameters<TestsStarter>) => {
        started = true;
        return starter(...args);
      },
      starter.inProcess ? { inProcess: true as const } : {},
    );
  const finished = startFeatureTester(workspace, created, watched)
    .catch(() => undefined)
    .then((reason) => {
      refused = reason;
      settled = true;
    });
  const deadline = Date.now() + RECORD_WAIT_MS;
  for (;;) {
    const record = await readTestsRecord(workspace, feature);
    if (record.ok && record.value?.status === "running" && started && watched?.inProcess)
      return {
        finished,
        testsNote: `Run visp work --feature ${feature} now; this command keeps running only to write VISP's acceptance tests — leave it running and do not run visp feature again.`,
      };
    if (settled || Date.now() >= deadline)
      return { finished, ...(refused ? { testsNote: refused } : {}) };
    await sleep(100);
  }
}

/**
 * The tester of an existing feature that has none, failed, or stopped without a result.
 * Resolves to the reason when its launch mode needs an opt-in the project does not give.
 */
async function restartTester(
  workspace: WorkspaceState,
  feature: string,
  starter: TestsStarter | undefined,
): Promise<string | undefined> {
  if (!starter) return undefined;
  const existing = await readTestsRecord(workspace, feature);
  if (!existing.ok) return undefined;
  if (!existing.value) {
    await startIndependentTests(workspace, feature, starter);
    return undefined;
  }
  if (!(await mayRestartTester(existing.value, true))) return undefined;
  const existingCodebase = await launchedOnExistingCode(workspace, feature);
  if (!existingCodebase.ok) return existingCodebase.error.message;
  const refused = executionRefusal(workspace, feature, existingCodebase.value);
  if (refused) return refused;
  await starter(workspace, feature, 0, true);
  return undefined;
}

async function summary(record: IndependentTestsRecord): Promise<IndependentTestsSummary> {
  if (record.status === "running")
    return (await isStale(record))
      ? {
          status: "failed",
          reason:
            "The tester stopped without a result; the host may end background processes when a command finishes",
        }
      : {
          status: "running",
          instructions:
            "An independent tester is writing acceptance tests from the original request. Keep working; visp done reports them once they are pinned.",
        };
  return {
    status: record.status,
    ...(record.file ? { file: record.file } : {}),
    ...(record.command ? { command: record.command } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.ambiguities?.length ? { ambiguities: record.ambiguities } : {}),
    ...(record.status === "pinned"
      ? {
          instructions:
            "These acceptance tests were written from the original request by an independent tester and are pinned: do not edit them. `visp done` on the last open slice (the only slice of a one-slice feature) runs and records them with your checks: run it as soon as the slice works instead of waiting for every test to pass by hand. No review call is spent while a check fails, unless the only failures are pinned tests you disputed. Long failure output is shortened; use --json or the local check-output log for details. Direct runs help iteration but are not recorded.",
        }
      : {}),
  };
}
