import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { hashValue, sha256 } from "../core/hash.js";
import { BUILD_ID, VERSION } from "../core/version.js";
import { adapterFor } from "./adapters.js";
import { assertOutside } from "./artifacts.js";
import type { StudyBudgetReservation } from "./budgets.js";
import type { NormalizedUsage, RunnerSpec } from "./contracts.js";
import { execute, executionEnvironment, git } from "./process.js";

export interface RunManifest {
  readonly schemaVersion: 1;
  readonly spec: RunnerSpec;
  readonly worktree: string;
  readonly startedAt: string;
  readonly runtime: {
    readonly visp: string;
    readonly buildId: string;
    readonly node: string;
    readonly platform: string;
  };
  readonly environmentVariableNames: readonly string[];
  readonly resumedFrom: string | null;
  readonly instructionEvidence: "pinned-files-only";
  readonly provenance: "local-runner";
  readonly initialSnapshotHash: string;
  readonly budgetReservation: StudyBudgetReservation;
}

export async function prepareRoot(spec: RunnerSpec, requested: string): Promise<string> {
  const adapter = adapterFor(spec.host.kind);
  if (spec.budget.monetaryEnforcement === "strict")
    throw new Error(
      "Strict dollar enforcement is unavailable for CLI adapters; use an approved estimated budget or an external billing boundary",
    );
  if (spec.permissions.requireSandbox)
    throw new Error(
      "This runner cannot independently establish the host sandbox; requireSandbox needs an external isolated host executor",
    );
  if (spec.harness.requiredHooks.length && !adapter.capabilities.hookEvents)
    throw new Error("This host does not expose required hook execution observations");
  if (process.platform === "win32")
    throw new Error(
      "The initial runner requires POSIX process-group cancellation; Windows execution is not yet qualified",
    );
  const repository = await realpath(spec.repository);
  if (repository !== spec.repository)
    throw new Error("Repository must use its canonical absolute path");
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const root = await realpath(requested);
  assertOutside(repository, root);
  const executable = await readFile(spec.host.executable);
  if (sha256(executable) !== spec.host.executableSha256)
    throw new Error("Host executable hash differs from the pinned build");
  const version = (
    await execute(
      spec.host.executable,
      ["--version"],
      repository,
      10_000,
      executionEnvironment(true),
    )
  ).trim();
  if (version !== spec.host.version)
    throw new Error(
      `Host version differs from pin: expected ${spec.host.version}; observed ${version}`,
    );
  const revision = (
    await git(repository, ["rev-parse", "--verify", `${spec.revision}^{commit}`])
  ).trim();
  if (revision !== spec.revision)
    throw new Error("Repository revision must name an exact existing commit");
  return root;
}

export async function verifyHarness(spec: RunnerSpec, worktree: string): Promise<void> {
  for (const file of spec.harness.files) {
    const target = join(worktree, file.path);
    if (!(await lstat(target)).isFile() || (await realpath(target)) !== target)
      throw new Error(`Harness input must be a regular confined file: ${file.path}`);
    if (sha256(await readFile(target)) !== file.sha256)
      throw new Error(`Harness configuration drift: ${file.path}`);
  }
}

export function manifestFor(
  spec: RunnerSpec,
  worktree: string,
  resumedFrom: string | null,
  initialSnapshotHash: string,
  budgetReservation: StudyBudgetReservation,
): RunManifest {
  return {
    schemaVersion: 1,
    spec,
    worktree,
    startedAt: new Date().toISOString(),
    runtime: {
      visp: VERSION,
      buildId: BUILD_ID,
      node: process.version,
      platform: process.platform,
    },
    environmentVariableNames: Object.keys(executionEnvironment(true)).sort(),
    resumedFrom,
    instructionEvidence: "pinned-files-only",
    provenance: "local-runner",
    initialSnapshotHash,
    budgetReservation,
  };
}

export function resumeIdentity(spec: RunnerSpec): string {
  return hashValue({
    repository: spec.repository,
    revision: spec.revision,
    task: spec.task,
    host: spec.host,
    permissions: spec.permissions,
    harness: spec.harness,
    feedbackLoop: spec.feedbackLoop,
    assignment: spec.assignment,
    studyBudget: {
      studyApprovalId: spec.budget.studyApprovalId,
      studyMaxEstimatedUsd: spec.budget.studyMaxEstimatedUsd,
    },
  });
}

export function estimateUsage(usage: readonly NormalizedUsage[], spec: RunnerSpec): number | null {
  if (!usage.length) return null;
  const prices = spec.budget.prices;
  let cost = 0;
  for (const row of usage) {
    if (row.model !== prices.model) return null;
    cost +=
      (row.inputTokens - row.cachedInputTokens - row.cacheWriteInputTokens) *
      prices.uncachedInputPerMillion;
    cost += row.cachedInputTokens * prices.cachedInputPerMillion;
    cost += row.cacheWriteInputTokens * prices.cacheWriteInputPerMillion;
    cost += row.outputTokens * prices.outputPerMillion;
  }
  return cost / 1_000_000;
}
