import { resolveCriticDefault } from "../config/critic-defaults.js";
import { DIR, PRODUCT_NAME, STATE_DIR } from "../core/constants.js";
import { isExecutableMode } from "../core/mode.js";
import {
  agentActivationFile,
  planAgentActivation,
  planAgentDeactivation,
  requiresAgentActivation,
} from "../harness/activation.js";
import {
  assetFingerprint,
  CLAUDE_SETTINGS_REGISTRATION,
  inspectForeignHarnessAssets,
  readAssetManifest,
} from "../harness/asset-inspection.js";
import { CLAUDE_SETTINGS_FILE, preToolUseRegistration } from "../harness/claude-settings.js";
import { preCommitHookPath } from "../harness/git-hook.js";
import { verifyGuardHandshake } from "../harness/guard-handshake.js";
import { HOOK_MARKER, renderPreCommitHook, renderPreToolUseHook } from "../harness/hooks.js";
import { type InstallState, readInstallState } from "../harness/install-state.js";
import { type Asset, planFor } from "../harness/targets.js";
import type { WorkspaceState } from "../workflow/state.js";
import type { Check, DoctorRuntime } from "./checks.js";

/**
 * Absence is not the only way an asset stops working. A file visp wrote and has
 * since changed the template for is stale, and looks identical to a healthy one
 * from a directory listing — so compare content, not just presence.
 */
export async function checkHarnessAssets(state: WorkspaceState): Promise<Check> {
  const installation = await readInstallState(state.paths, state.files);
  if (!installation.ok) {
    return {
      name: "harness assets",
      status: "fail",
      detail: installation.error.message,
      recovery: `${PRODUCT_NAME} install`,
    };
  }
  const profile =
    installation.value?.harness === state.config.harness
      ? installation.value.profile
      : state.config.profile;
  const critic = await resolveCriticDefault(state.config.harness, state.config.critic);
  if (!critic.ok) {
    return {
      name: "harness assets",
      status: "unknown",
      detail: critic.error.message,
      recovery: `${PRODUCT_NAME} install`,
    };
  }
  const plan = planFor(state.config.harness, profile, critic.value);
  const manifest = await readAssetManifest(state.paths);
  const recorded = manifest.ok ? manifest.value : {};

  const { missing, stale, edited } = await inspectHarnessAssetFiles(state, plan.assets, recorded);

  const note =
    edited.length > 0 ? `; edited by you, left alone: ${edited.slice(0, 3).join(", ")}` : "";

  if (missing.length > 0) {
    return {
      name: "harness assets",
      status: "warn",
      detail: `Missing for ${state.config.harness}: ${missing.slice(0, 3).join(", ")}${note}`,
      recovery: `${PRODUCT_NAME} install`,
    };
  }

  if (stale.length > 0) {
    return {
      name: "harness assets",
      status: "warn",
      detail: `Stale for ${state.config.harness}: ${stale.slice(0, 3).join(", ")}${note}`,
      recovery: `${PRODUCT_NAME} install --force`,
    };
  }

  if (edited.length > 0) {
    return {
      name: "harness assets",
      status: "warn",
      detail: `Edited for ${state.config.harness}: ${edited.slice(0, 3).join(", ")}; edited by you, left alone`,
      recovery: `Review the preserved files; run ${PRODUCT_NAME} install --force only if VISP should replace them`,
    };
  }

  return {
    name: "harness assets",
    status: "ok",
    detail: `${state.config.harness} assets are installed${note}`,
  };
}

async function inspectHarnessAssetFiles(
  state: WorkspaceState,
  assets: readonly Asset[],
  recorded: Readonly<Record<string, string>>,
): Promise<{ missing: string[]; stale: string[]; edited: string[] }> {
  const result = { missing: [] as string[], stale: [] as string[], edited: [] as string[] };
  for (const asset of assets) {
    const current = await state.files.readTextIfExists(asset.path);
    if (!current.ok || current.value === undefined) {
      result.missing.push(asset.path);
      continue;
    }
    if (current.value === asset.content) continue;

    // Matching what we recorded means visp wrote it and the template has since
    // moved on. Anything else is the user's edit, which is theirs to keep.
    const destination =
      recorded[asset.path] === assetFingerprint(current.value) ? result.stale : result.edited;
    destination.push(asset.path);
  }
  return result;
}

export async function checkHarnessActivation(state: WorkspaceState): Promise<Check> {
  if (!requiresAgentActivation(state.config.harness)) {
    return {
      name: "harness activation",
      status: "ok",
      detail: `${state.config.harness} does not require a managed AGENTS.md reference`,
    };
  }

  const current = await state.files.readTextIfExists(agentActivationFile(state.config.harness));
  if (!current.ok) {
    return {
      name: "harness activation",
      status: "unknown",
      detail: `Could not inspect ${agentActivationFile(state.config.harness)}: ${current.error.message}`,
      recovery: `${PRODUCT_NAME} install`,
    };
  }
  const activation = planAgentActivation(state.config.harness, current.value, false);
  if (!activation.ok) {
    return {
      name: "harness activation",
      status: "fail",
      detail: activation.error.message,
      recovery: `${PRODUCT_NAME} install --force`,
    };
  }
  return activation.value.status === "current"
    ? {
        name: "harness activation",
        status: "ok",
        detail: `${agentActivationFile(state.config.harness)} activates ${state.config.harness} instructions`,
      }
    : {
        name: "harness activation",
        status: "warn",
        detail: `${agentActivationFile(state.config.harness)} does not activate the installed VISP guide`,
        recovery: `${PRODUCT_NAME} install`,
      };
}

export async function checkPreviousHarnessAssets(state: WorkspaceState): Promise<Check> {
  const found = await inspectForeignHarnessAssets(state.paths, state.config.harness);
  if (!found.ok) {
    return {
      name: "previous harness assets",
      status: "unknown",
      detail: `Could not inspect prior assets: ${found.error.message}`,
    };
  }
  const owned = [
    ...found.value.owned,
    ...(found.value.claudeRegistration ? [CLAUDE_SETTINGS_REGISTRATION] : []),
    ...found.value.mcpRegistrations.map(({ path }) => `${path} (VISP MCP registration)`),
  ];
  const edited = [...found.value.edited];
  await collectPreviousActivations(state, owned, edited);
  const manual = [...edited, ...found.value.unrecognized];
  if (owned.length === 0 && manual.length === 0) {
    return {
      name: "previous harness assets",
      status: "ok",
      detail: "No previous-harness residue found",
    };
  }
  // Keep active hooks and registrations visible when adding another host asset.
  owned.sort(
    (a, b) => Number(/registration|hooks\//.test(b)) - Number(/registration|hooks\//.test(a)),
  );
  const detail = [
    ...(owned.length > 0
      ? [
          `VISP-owned assets for another harness remain: ${owned.slice(0, 3).join(", ")}${owned.length > 3 ? ` (+${owned.length - 3} more)` : ""}`,
        ]
      : []),
    ...(manual.length > 0
      ? [
          `Edited or unrecognized previous-harness files were preserved for manual review: ${manual
            .slice(0, 3)
            .join(", ")}`,
        ]
      : []),
  ].join(". ");
  return {
    name: "previous harness assets",
    status: "warn",
    detail,
    recovery:
      owned.length > 0
        ? `${PRODUCT_NAME} install --prune-previous-harness; review preserved files manually`
        : "Review the preserved files and remove them manually only if they are obsolete",
  };
}

async function collectPreviousActivations(
  state: WorkspaceState,
  owned: string[],
  edited: string[],
): Promise<void> {
  for (const path of ["AGENTS.md", "CLAUDE.md"]) {
    if (
      requiresAgentActivation(state.config.harness) &&
      path === agentActivationFile(state.config.harness)
    )
      continue;
    const current = await state.files.readTextIfExists(path);
    if (!current.ok) continue;
    const status = planAgentDeactivation(current.value).status;
    if (status === "removed") owned.push(`${path} (VISP activation block)`);
    if (status === "edited") edited.push(`${path} (edited VISP activation block)`);
  }
}

/**
 * The surfaces that actually refuse an out-of-scope change. Everything else in
 * this report describes what visp knows; this describes whether anything acts
 * on it. A project with none of these installed is running unenforced, and
 * saying otherwise would be the exact failure the tool exists to prevent.
 */
export async function checkEnforcement(
  state: WorkspaceState,
  runtime: DoctorRuntime,
): Promise<Check> {
  const requested = await readInstallState(state.paths, state.files);
  if (!requested.ok) {
    return {
      name: "enforcement",
      status: "fail",
      detail: requested.error.message,
      recovery: `${PRODUCT_NAME} install`,
    };
  }
  const installation =
    requested.value?.harness === state.config.harness ? requested.value : undefined;
  const surfaces = await inspectEnforcementSurfaces(state, installation);

  if (installation?.hooks.every((hook) => hook === "ci")) {
    return {
      name: "enforcement",
      status: "warn",
      detail:
        "Nothing enforces scope locally because local hooks were explicitly omitted" +
        (installation.hooks.includes("ci") ? "; generated CI remains the requested boundary" : ""),
    };
  }

  // Both hooks shell out to `visp`. Installed but unrunnable is worse than not
  // installed: the edit hook denies every write when it cannot check, and the
  // pre-commit hook refuses an active task's commit. Only worth asking once a surface
  // that would run it exists.
  const inspectionCouldNotRun = surfaces.inactive.some((surface) =>
    surface.includes("configured path could not be resolved"),
  );
  const runtimeProblem =
    surfaces.active.length > 0 || inspectionCouldNotRun
      ? await guardRuntimeProblem(state.paths.root, runtime)
      : undefined;
  if (runtimeProblem) {
    return {
      name: "enforcement",
      status: "fail",
      detail: `${surfaces.active.length ? `${surfaces.active.join(", ")} installed, but ` : "Guard availability could not be established: "}${runtimeProblem.message}`,
      recovery: runtimeProblem.recovery ?? `${PRODUCT_NAME} guard --handshake --json`,
    };
  }

  if (surfaces.inactive.length === 0) {
    return {
      name: "enforcement",
      status: "ok",
      detail: `Refusals are enforced by local guardrails: ${surfaces.active.join(", ")}. CI remains authoritative`,
    };
  }

  return {
    name: "enforcement",
    status: "warn",
    detail:
      surfaces.active.length === 0
        ? `Nothing enforces scope: ${surfaces.inactive.join(", ")} not installed`
        : `Active: ${surfaces.active.join(", ")}. Not installed: ${surfaces.inactive.join(", ")}`,
    recovery: `${PRODUCT_NAME} doctor --fix`,
  };
}

interface EnforcementSurfaces {
  readonly active: string[];
  readonly inactive: string[];
}

async function inspectEnforcementSurfaces(
  state: WorkspaceState,
  installation?: InstallState,
): Promise<EnforcementSurfaces> {
  const surfaces: EnforcementSurfaces = { active: [], inactive: [] };
  const wantsClaude = installation
    ? installation.hooks.includes("claude")
    : state.config.harness === "claude-code";
  const wantsGit = installation ? installation.hooks.includes("git") : true;
  if (state.config.harness === "claude-code" && wantsClaude) {
    addSurface(surfaces, await inspectClaudeEditHook(state));
  }
  if (wantsGit) addSurface(surfaces, await inspectPreCommitHook(state));
  return surfaces;
}

interface SurfaceState {
  readonly active?: string;
  readonly inactive?: string;
}

function addSurface(surfaces: EnforcementSurfaces, state: SurfaceState): void {
  if (state.active) surfaces.active.push(state.active);
  if (state.inactive) surfaces.inactive.push(state.inactive);
}

async function inspectClaudeEditHook(state: WorkspaceState): Promise<SurfaceState> {
  const hookPath = `${STATE_DIR}/${DIR.hooks}/claude-pretooluse.mjs`;
  const script = await state.files.readTextIfExists(hookPath);
  if (!script.ok || script.value === undefined) return { inactive: "edit hook" };
  if (script.value !== renderPreToolUseHook()) return { inactive: "edit hook (stale or edited)" };
  const metadata = await state.files.metadata(hookPath);
  if (!metadata.ok || !isExecutableMode(metadata.value?.mode)) {
    return { inactive: "edit hook (not executable)" };
  }

  const wired = await preToolUseRegistration(state.paths.root, hookPath);
  const registration = wired.ok ? wired.value : "absent";
  if (registration === "present") return { active: "edit hook" };
  if (registration === "malformed") {
    return { inactive: `edit hook (${CLAUDE_SETTINGS_FILE} is not valid JSON)` };
  }
  if (registration === "customized") {
    return { inactive: "edit hook (settings registration is stale or edited)" };
  }
  return { inactive: "edit hook (script written, not wired into settings)" };
}

async function inspectPreCommitHook(state: WorkspaceState): Promise<SurfaceState> {
  const resolved = await preCommitHookPath(state.paths.root);
  if (!resolved.ok) return { inactive: "pre-commit (configured path could not be resolved)" };
  const hook = await state.files.readTextIfExists(resolved.value.absolute);
  if (!hook.ok) return { inactive: `pre-commit (${hook.error.message})` };
  if (hook.value === renderPreCommitHook()) {
    const metadata = await state.files.metadata(resolved.value.absolute);
    if (metadata.ok && isExecutableMode(metadata.value?.mode)) return { active: "pre-commit" };
    return { inactive: "pre-commit (not executable)" };
  }
  if (hook.ok && (hook.value ?? "").includes(HOOK_MARKER)) {
    return { inactive: "pre-commit (stale or edited)" };
  }
  if (hook.ok && hook.value !== undefined) {
    return { inactive: "pre-commit (a hook is there, but not this one)" };
  }
  return { inactive: "pre-commit" };
}

async function guardRuntimeProblem(root: string, runtime: DoctorRuntime) {
  const handshake = await (runtime.guardHandshake ?? verifyGuardHandshake)(root);
  return handshake.ok ? undefined : handshake.error;
}
