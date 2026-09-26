import { resolveCriticDefault } from "../config/critic-defaults.js";
import { loadConfig } from "../config/load.js";
import { defaultConfig, type VispConfig } from "../config/schema.js";
import { DIR, FILE, STATE_DIR } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import { RecoveringProjectFileSystem, recoverFileTransactions } from "../core/file-transaction.js";
import type { ProjectFileSystem } from "../core/fs.js";
import { currentBranch, headCommit, isRepository, workingTreeChanges } from "../core/git.js";
import { parseFeatureId } from "../core/input.js";
import { isExecutableMode } from "../core/mode.js";
import { ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import {
  agentActivationFile,
  planAgentActivation,
  requiresAgentActivation,
} from "../harness/activation.js";
import { preToolUseRegistration } from "../harness/claude-settings.js";
import { preCommitHookPath } from "../harness/git-hook.js";
import { renderPreCommitHook, renderPreToolUseHook } from "../harness/hooks.js";
import { planFor } from "../harness/targets.js";
import { now } from "./artifacts/common.js";
import type { ImplementMarker } from "./artifacts/evidence.js";
import type { Status } from "./artifacts/project.js";
import { ArtifactStore } from "./artifacts/store.js";
import { findTask, type Task } from "./artifacts/tasks.js";
import { type Override, overrideStoreSchema, type Policy, policySchema } from "./policy/schema.js";
import { productScopes } from "./product/scopes.js";

/**
 * Loads everything a command needs in one pass. Commands receive this rather
 * than re-reading `.visp/` themselves, so two commands cannot disagree about
 * the current state.
 */
export interface WorkspaceState {
  readonly paths: ProjectPaths;
  readonly files: ProjectFileSystem;
  readonly store: ArtifactStore;
  readonly config: VispConfig;
  readonly policy: Policy;
  readonly overrides: readonly Override[];
  readonly status: Status | undefined;
}

export async function loadWorkspace(root: string): Promise<Result<WorkspaceState>> {
  const paths = new ProjectPaths(root);
  const files = new RecoveringProjectFileSystem(paths.root);

  // A lock may create .visp/state before init; the tracked project record marks setup.
  const project = await files.metadata(paths.project);
  if (!project.ok) return project;
  if (project.value?.type !== "file") {
    return err(
      vispError("NOT_INITIALIZED", "This project is not set up for visp", {
        recovery: "visp init --harness <name>",
      }),
    );
  }

  const config = await loadConfig(paths);
  if (!config.ok) return config;

  const store = new ArtifactStore(paths, files);
  const policy = await loadPolicy(paths, files, config.value);
  if (!policy.ok) return policy;

  const overrides = await loadOverrides(paths, files);
  if (!overrides.ok) return overrides;

  const status = await store.readStatusIfExists();
  if (!status.ok) return status;

  const resolved = await withLatestFeature(store, status.value);
  if (!resolved.ok) return resolved;

  return ok({
    paths,
    files,
    store,
    config: config.value,
    policy: policy.value,
    overrides: overrides.value,
    status: resolved.value,
  });
}

/** Recover first, then load; mutators must never plan from a partly applied transaction. */
export async function loadWorkspaceForMutation(root: string): Promise<Result<WorkspaceState>> {
  const recovered = await recoverFileTransactions(root);
  if (!recovered.ok) return recovered;
  return loadWorkspace(root);
}

/**
 * Which feature is active is per-developer state and is not committed, so a
 * fresh clone or worktree has none. The features themselves are tracked, so
 * fall back to the most recent one rather than claiming there is no work.
 * Held in memory only: nothing is written until a command actually changes it.
 */
async function withLatestFeature(
  store: ArtifactStore,
  status: Status | undefined,
): Promise<Result<Status | undefined>> {
  if (status?.activeFeature) return ok(status);

  const features = await store.listFeatures();
  if (!features.ok) return features;

  const latest = features.value[0];
  if (!latest) return ok(status);

  const base = status ?? { kind: "status" as const, createdAt: now(), updatedAt: now() };
  return ok({ ...base, activeFeature: latest });
}

/**
 * Policy defaults follow `visp.yml` until the project records a decision of its
 * own, so strictness has one obvious place to live.
 */
async function loadPolicy(
  paths: ProjectPaths,
  files: ProjectFileSystem,
  config: VispConfig,
): Promise<Result<Policy>> {
  const stored = await files.readJsonIfExists(paths.policy, (value) => {
    const parsed = policySchema.safeParse(value);
    return parsed.success
      ? ok(parsed.data)
      : err(vispError("ARTIFACT_INVALID", `Invalid ${FILE.policy}: ${parsed.error.message}`));
  });
  if (!stored.ok) return stored;

  return ok(
    stored.value ?? {
      kind: "policy",
      createdAt: now(),
      strictness: config.workflow.strictness,
      rules: {},
    },
  );
}

async function loadOverrides(
  paths: ProjectPaths,
  files: ProjectFileSystem,
): Promise<Result<Override[]>> {
  const stored = await files.readJsonIfExists(paths.overrides, (value) => {
    const parsed = overrideStoreSchema.safeParse(value);
    return parsed.success
      ? ok(parsed.data)
      : err(vispError("ARTIFACT_INVALID", `Invalid ${FILE.overrides}: ${parsed.error.message}`));
  });
  if (!stored.ok) return stored;
  return ok(stored.value?.overrides ?? []);
}

export async function saveOverrides(
  paths: ProjectPaths,
  overrides: readonly Override[],
): Promise<Result<void>> {
  return new RecoveringProjectFileSystem(paths.root).writeJson(paths.overrides, {
    kind: "overrides",
    createdAt: now(),
    overrides,
  });
}

export async function savePolicy(paths: ProjectPaths, policy: Policy): Promise<Result<void>> {
  return new RecoveringProjectFileSystem(paths.root).writeJson(paths.policy, policy);
}

/** The feature a command should act on: an explicit choice, or the active one. */
export function resolveFeature(state: WorkspaceState, explicit?: string): Result<string> {
  if (explicit !== undefined) return parseFeatureId(explicit);
  const feature = explicit ?? state.status?.activeFeature;
  if (!feature) {
    return err(
      vispError("NO_ACTIVE_FEATURE", "No feature is active", {
        recovery: 'visp feature "<goal>"',
      }),
    );
  }
  return ok(feature);
}

export interface FoundationContext {
  readonly harnessInstalled?: boolean;
  readonly enforcementInstalled?: boolean;
  readonly repositoryAvailable?: boolean;
  readonly hasBaseline?: boolean;
  readonly changedFiles?: readonly string[];
}

/** Foundation checks do not read feature artifacts, including historical legacy drafts. */
export async function buildFoundationContext(
  state: WorkspaceState,
): Promise<Result<FoundationContext>> {
  const [harnessInstalled, enforcementInstalled, repositoryAvailable, baseline, changedFiles] =
    await Promise.all([
      hasHarnessAssets(state),
      hasEnforcementSurface(state),
      isRepository(state.paths.root),
      headCommit(state.paths.root),
      changedFilesOf(state),
    ]);
  return ok({
    harnessInstalled,
    enforcementInstalled,
    repositoryAvailable,
    hasBaseline: baseline.ok,
    ...(changedFiles ? { changedFiles } : {}),
  });
}

async function hasHarnessAssets(state: WorkspaceState): Promise<boolean> {
  const critic = await resolveCriticDefault(state.config.harness, state.config.critic);
  if (!critic.ok) return false;
  const assets = planFor(state.config.harness, state.config.profile, critic.value).assets;
  if (assets.length === 0) return false;

  const current = await Promise.all(
    assets.map(async (asset) => {
      const installed = await state.files.readTextIfExists(asset.path);
      if (!installed.ok || installed.value !== asset.content) return false;
      if (asset.executable !== true) return true;

      const metadata = await state.files.metadata(asset.path);
      return metadata.ok && isExecutableMode(metadata.value?.mode);
    }),
  );
  if (!current.every(Boolean)) return false;

  if (!requiresAgentActivation(state.config.harness)) return true;
  const activation = await state.files.readTextIfExists(agentActivationFile(state.config.harness));
  if (!activation.ok) return false;
  const planned = planAgentActivation(state.config.harness, activation.value, false);
  return planned.ok && planned.value.status === "current";
}

async function hasEnforcementSurface(state: WorkspaceState): Promise<boolean> {
  const hookPath = await preCommitHookPath(state.paths.root);
  if (hookPath.ok) {
    const preCommit = await state.files.readTextIfExists(hookPath.value.absolute);
    const metadata = await state.files.metadata(hookPath.value.absolute);
    if (
      preCommit.ok &&
      preCommit.value === renderPreCommitHook() &&
      metadata.ok &&
      isExecutableMode(metadata.value?.mode)
    ) {
      return true;
    }
  }

  if (state.config.harness !== "claude-code") return false;
  const editHookPath = `${STATE_DIR}/${DIR.hooks}/claude-pretooluse.mjs`;
  const editHook = await state.files.readTextIfExists(editHookPath);
  if (!editHook.ok || editHook.value !== renderPreToolUseHook()) return false;
  const metadata = await state.files.metadata(editHookPath);
  if (!metadata.ok || !isExecutableMode(metadata.value?.mode)) return false;
  const registration = await preToolUseRegistration(state.paths.root, editHookPath);
  return registration.ok && registration.value === "present";
}

/**
 * Undefined when the diff could not be read, which the rules treat as unknown.
 * visp's own artifacts are excluded: they change on every command, they are
 * never a scope violation, and counting them would spend the changed-file
 * budget on the tool's own bookkeeping.
 */
async function changedFilesOf(state: WorkspaceState): Promise<string[] | undefined> {
  const changes = await workingTreeChanges(state.paths.root);
  if (!changes.ok) return undefined;

  return changes.value.files.map((file) => file.path).filter((path) => !isStatePath(path));
}

export function isStatePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === STATE_DIR || normalized.startsWith(`${STATE_DIR}/`);
}

/**
 * The feature whose intent records this branch.
 *
 * CI has no active feature of its own: `status.json` is per-developer and is not
 * committed. The branch is, so it is what ties a pull request back to the scope
 * it was supposed to stay inside. Undefined when nothing matches, which the
 * caller must treat as "ask explicitly" rather than "any feature will do".
 */
export async function featureForBranch(
  state: WorkspaceState,
  branchOverride?: string,
): Promise<string | undefined> {
  // A detached checkout has no branch to read — `rev-parse --abbrev-ref HEAD`
  // answers the literal string "HEAD" — and that is the normal state in CI:
  // actions/checkout detaches for a pull_request event. So the caller may say
  // which branch this checkout represents when git cannot.
  const name = (branchOverride ?? (await readBranch(state))).trim();
  if (name === "" || name === "HEAD") return undefined;

  const features = await state.store.listFeatures();
  if (!features.ok) return undefined;

  for (const feature of features.value) {
    const intent = await state.store.readIntent(feature);
    if (intent.ok && intent.value.branch === name) return feature;
  }
  return undefined;
}

async function readBranch(state: WorkspaceState): Promise<string> {
  const branch = await currentBranch(state.paths.root);
  return branch.ok ? branch.value : "";
}

/** Where the scope being enforced comes from. */
export type ScopeSource = "markers" | "tasks";

export interface ScopeOptions {
  readonly includeDone?: boolean;
  readonly feature?: string;
  /**
   * `markers` is the working-tree question: what may be edited on this machine
   * right now. `tasks` is the pull-request question: what this feature ever
   * declared it would touch. Markers are per-worktree and not committed, so a
   * fresh checkout — which is all CI ever has — can only ask the second one.
   */
  readonly source?: ScopeSource;
}

/**
 * Scopes that a change may legitimately fall under.
 *
 * Active authorizations say what may be edited now. Completed tasks matter for a
 * different question: work that visp already verified and closed still has to be
 * committable, and clearing its marker must not strand it in the working tree.
 */
export async function authorizedScopes(
  state: WorkspaceState,
  options: ScopeOptions = {},
): Promise<Result<ImplementMarker[]>> {
  const feature = options.feature ?? state.status?.activeFeature;
  if (feature) {
    const brief = await state.files.exists(state.paths.featureFile(feature, "brief.yaml"));
    if (!brief.ok) return brief;
    if (brief.value) return productScopes(state, options);
  }

  return legacyAuthorizedScopes(state, options);
}

/** Historical evidence readers retain their original scope interpretation. */
async function legacyAuthorizedScopes(
  state: WorkspaceState,
  options: ScopeOptions,
): Promise<Result<ImplementMarker[]>> {
  const feature = options.feature ?? state.status?.activeFeature;
  if (options.source === "tasks") {
    if (!feature) return ok([]);
    const graph = await state.store.readTasksIfExists(feature);
    if (!graph.ok) return graph;
    if (!graph.value) return ok([]);
    return ok(graph.value.tasks.map((task) => markerFor(feature, task)));
  }

  const active = await readOpenMarkers(state);
  if (!active.ok || !options.includeDone) return active;
  if (!feature) return active;

  const graph = await state.store.readTasksIfExists(feature);
  if (!graph.ok || !graph.value) return active;

  const authorized = new Set(active.value.map((marker) => marker.task));
  const completed = graph.value.tasks
    .filter((task) => task.status === "done" && !authorized.has(task.id))
    .map((task) => markerFor(feature, task));

  return ok([...active.value, ...completed]);
}

/** Only a task proven closed can retire its marker; missing state stays conservative. */
async function readOpenMarkers(state: WorkspaceState): Promise<Result<ImplementMarker[]>> {
  const active = await state.store.readActiveMarkers();
  if (!active.ok) return active;

  const graphs = new Map<string, Awaited<ReturnType<ArtifactStore["readTasksIfExists"]>>>();
  const open: ImplementMarker[] = [];
  for (const marker of active.value) {
    let graph = graphs.get(marker.feature);
    if (!graph) {
      graph = await state.store.readTasksIfExists(marker.feature);
      graphs.set(marker.feature, graph);
    }
    if (!graph.ok) return graph;
    const task = graph.value ? findTask(graph.value, marker.task) : undefined;
    if (task?.status !== "done") open.push(marker);
  }
  return ok(open);
}

function markerFor(feature: string, task: Task): ImplementMarker {
  return {
    kind: "implement-marker",
    createdAt: now(),
    feature,
    task: task.id,
    allowedFiles: task.allowedFiles,
    expectedFiles: task.expectedFiles,
    forbiddenFiles: task.forbiddenFiles,
  };
}

export { defaultConfig };
