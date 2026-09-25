import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_PROFILE, type Harness } from "../core/constants.js";
import { fromUnknown, vispError } from "../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  recoverFileTransactions,
} from "../core/file-transaction.js";
import { ProjectFileSystem } from "../core/fs.js";
import { isRepository, repositoryRequiredError } from "../core/git.js";
import type { ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import { buildInstallPlan, localEnforcementRequirements } from "./install-plan.js";
import { installationRecovery } from "./install-recovery.js";
import type {
  HookKind,
  InstallOptions,
  InstallOutcome,
  InstallPlan,
  InstallRuntime,
} from "./install-types.js";
import { verifyInstalledHarness } from "./install-verification.js";

export type {
  ForeignHarnessAssets,
  ForeignMcpRegistration,
  McpRegistrationHarness,
} from "./asset-inspection.js";
export {
  assetFingerprint,
  CLAUDE_SETTINGS_REGISTRATION,
  inspectForeignHarnessAssets,
  readAssetManifest,
} from "./asset-inspection.js";
export { previewHarnessInstall } from "./install-preview.js";
export type {
  AssetManifest,
  AssetStatus,
  HookKind,
  InstalledAsset,
  InstallOptions,
  InstallOutcome,
  InstallPreview,
  InstallRuntime,
} from "./install-types.js";

export function defaultHooks(harness: Harness): HookKind[] {
  return harness === "claude-code" ? ["claude", "git"] : ["git"];
}

/** Plans every target before applying the group as one recoverable transaction. */
export async function installHarness(
  paths: ProjectPaths,
  options: InstallOptions,
  runtime: InstallRuntime = {},
): Promise<Result<InstallOutcome>> {
  const fs = new ProjectFileSystem(paths.root);
  if ((options.hooks ?? []).includes("git") && !(await isRepository(paths.root))) {
    const gitDirectory = await fs.exists(".git");
    if (!gitDirectory.ok) return gitDirectory;
    return err(repositoryRequiredError(gitDirectory.value));
  }

  const recovered = await recoverFileTransactions(paths.root);
  if (!recovered.ok) return err(installationRecovery(recovered.error, options));

  const profile = options.profile ?? DEFAULT_PROFILE;
  const planned = await buildInstallPlan(paths, options, profile, fs);
  if (!planned.ok) return err(installationRecovery(planned.error, options));

  const parents = await prepareInstallParents(fs, planned.value.mutations);
  if (!parents.ok) return err(installationRecovery(parents.error, options));

  const apply = runtime.applyTransaction ?? applyFileTransaction;
  const applied = await apply(paths.root, "harness-install", planned.value.mutations);
  if (!applied.ok) {
    await removeInstallParents(fs, parents.value);
    return err(installationRecovery(applied.error, options));
  }

  try {
    await runtime.afterApply?.();
  } catch (cause) {
    return err(installationRecovery(fromUnknown(cause, "IO_ERROR"), options));
  }
  const verified = await verifyInstalledHarness(
    paths,
    options,
    profile,
    planned.value,
    fs,
    runtime,
  );
  if (!verified.ok) return err(installationRecovery(verified.error, options));

  return ok(installOutcome(options, planned.value));
}

/**
 * Create missing parent components before the transaction writes files.
 *
 * Some host sandboxes reject a recursive mkdir when more than one component is
 * absent. Creating each component separately keeps the first install usable,
 * while the recorded list lets an apply failure remove only empty directories
 * created by this install attempt.
 */
async function prepareInstallParents(
  fs: ProjectFileSystem,
  mutations: readonly FileMutation[],
): Promise<Result<string[]>> {
  const parents = new Set<string>();
  for (const mutation of mutations) {
    const components = installParentComponents(fs, mutation.path);
    if (!components.ok) return components;
    for (const parent of components.value) parents.add(parent);
  }

  const created: string[] = [];
  for (const parent of [...parents].sort((left, right) => left.length - right.length)) {
    const ensured = await ensureInstallParent(fs, parent);
    if (!ensured.ok) {
      await removeInstallParents(fs, created);
      return ensured;
    }
    if (ensured.value) created.push(parent);
  }
  return ok(created);
}

function installParentComponents(fs: ProjectFileSystem, path: string): Result<string[]> {
  const parent = dirname(path);
  const absolute = isAbsolute(parent) ? resolve(parent) : resolve(fs.root, parent);
  const relativeParent = relative(fs.root, absolute);
  if (relativeParent === "" || relativeParent === ".") return ok([]);
  if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`)) {
    return err(vispError("IO_ERROR", `Refusing install parent outside project: ${parent}`));
  }
  const components: string[] = [];
  let current = fs.root;
  for (const component of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, component);
    components.push(current);
  }
  return ok(components);
}

async function ensureInstallParent(
  fs: ProjectFileSystem,
  parent: string,
): Promise<Result<boolean>> {
  const metadata = await fs.metadata(parent);
  if (!metadata.ok) return metadata;
  if (metadata.value) {
    return metadata.value.type === "directory"
      ? ok(false)
      : err(vispError("IO_ERROR", `Project path parent is not a directory: ${parent}`));
  }
  const ensured = await fs.ensureDir(parent);
  return ensured.ok ? ok(true) : ensured;
}

async function removeInstallParents(
  fs: ProjectFileSystem,
  parents: readonly string[],
): Promise<void> {
  for (const parent of [...parents].reverse()) await fs.removeDir(parent).catch(() => undefined);
}

function installOutcome(options: InstallOptions, plan: InstallPlan): InstallOutcome {
  return {
    harness: options.harness,
    assets: plan.assets,
    manualSteps: plan.manualSteps,
    requirements: [
      ...localEnforcementRequirements(options),
      "Before starting a feature, review and commit the project baseline including setup changes. VISP does not stage files or create the commit.",
    ],
    ...(plan.activation ? { activation: plan.activation } : {}),
    ...(plan.settingsSnippet ? { settingsSnippet: plan.settingsSnippet } : {}),
    ...(plan.claudeSettings ? { claudeSettings: plan.claudeSettings } : {}),
    ...(plan.mcp ? { mcp: plan.mcp } : {}),
    ...(plan.mcpConfigFile ? { mcpConfigFile: plan.mcpConfigFile } : {}),
  };
}
