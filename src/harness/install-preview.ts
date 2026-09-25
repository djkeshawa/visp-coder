import { DEFAULT_PROFILE } from "../core/constants.js";
import { type VispError, vispError } from "../core/errors.js";
import { inspectFileTransactions } from "../core/file-transaction.js";
import { ProjectFileSystem } from "../core/fs.js";
import {
  headCommit,
  isRepository,
  repositoryRequiredError,
  workingTreeChanges,
} from "../core/git.js";
import type { ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import { buildInstallPlan, localEnforcementRequirements } from "./install-plan.js";
import { installationRecovery } from "./install-recovery.js";
import type { InstallOptions, InstallPreview } from "./install-types.js";

/** Uses the real installation planner without recovery, writes, or executing a guard. */
export async function previewHarnessInstall(
  paths: ProjectPaths,
  options: InstallOptions,
): Promise<Result<InstallPreview>> {
  const fs = new ProjectFileSystem(paths.root);
  const [repository, baseline, changed, transactions] = await Promise.all([
    isRepository(paths.root),
    headCommit(paths.root),
    workingTreeChanges(paths.root),
    inspectFileTransactions(paths.root),
  ]);
  const localEnforcement = (options.hooks ?? []).some(
    (hook) => hook === "git" || hook === "claude",
  );
  const requirements = installationRequirements(
    repository,
    baseline.ok,
    options,
    changed.ok ? changed.value.files.length : undefined,
  );
  if (!transactions.ok) return previewError(transactions.error, requirements);
  if (transactions.value.pending.length > 0) {
    return previewError(
      vispError(
        "STAGE_BLOCKED",
        "Installation preview requires recovery of a pending transaction",
        {
          recovery: "visp doctor --fix",
          details: { pending: transactions.value.pending },
        },
      ),
      requirements,
    );
  }
  if ((options.hooks ?? []).includes("git") && !repository) {
    const metadata = await fs.exists(".git");
    if (!metadata.ok) return previewError(metadata.error, requirements);
    return previewError(repositoryRequiredError(metadata.value), requirements);
  }
  const profile = options.profile ?? DEFAULT_PROFILE;
  const planned = await buildInstallPlan(paths, options, profile, fs);
  if (!planned.ok) return previewError(installationRecovery(planned.error, options), requirements);
  return ok({
    dryRun: true,
    harness: options.harness,
    profile,
    localEnforcement: localEnforcement ? "requested" : "omitted",
    repositoryAvailable: repository,
    hasBaseline: baseline.ok,
    ...(changed.ok ? { changedFiles: changed.value.files.map((file) => file.path) } : {}),
    changes: planned.value.mutations.map((mutation) => ({
      operation: mutation.kind,
      path: paths.relative(mutation.path) ?? mutation.path,
      ...(mutation.kind === "write" && mutation.mode !== undefined ? { mode: mutation.mode } : {}),
    })),
    requirements,
    manualSteps: planned.value.manualSteps,
  });
}

function previewError(error: VispError, requirements: readonly string[]): Result<never> {
  return err({
    ...error,
    message: [
      error.message,
      "Known setup requirements:",
      ...requirements.map((requirement) => `- ${requirement}`),
    ].join("\n"),
    details: { ...error.details, requirements },
  });
}

function installationRequirements(
  repository: boolean,
  hasBaseline: boolean,
  options: InstallOptions,
  changedCount?: number,
): string[] {
  const enforcement = localEnforcementRequirements(options);
  return [
    "This read-only preview does not test write permissions. Host-protected configuration and agent directories may require the host's approval when installation runs.",
    ...(repository
      ? []
      : [
          "Initialize or repair Git before authorizing feature work; VISP does not change Git metadata automatically.",
        ]),
    ...(enforcement.length === 0
      ? [
          "Requested local hooks must pass the installed guard handshake before coding can be authorized.",
        ]
      : enforcement),
    ...(!hasBaseline ? ["The repository needs its first committed project baseline."] : []),
    ...(changedCount === undefined
      ? ["Working-tree changes could not be inspected; baseline readiness is unverified."]
      : []),
    ...(changedCount !== undefined && changedCount > 0
      ? [
          `The working tree already has ${changedCount} changed file(s). Review existing changes together with planned setup changes before committing the feature baseline.`,
        ]
      : []),
    "Complete installation, then review and commit setup changes before starting a feature. VISP will not stage files or create the commit.",
  ];
}
