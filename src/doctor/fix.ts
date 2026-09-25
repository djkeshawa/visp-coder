import { PRODUCT_NAME } from "../core/constants.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
  recoverFileTransactions,
} from "../core/file-transaction.js";
import type { Result } from "../core/result.js";
import { indexRepository, refreshRepository } from "../graph/index.js";
import { CLAUDE_SETTINGS_FILE } from "../harness/claude-settings.js";
import {
  defaultHooks,
  type HookKind,
  type InstallOutcome,
  type InstallRuntime,
  installHarness,
} from "../harness/install.js";
import { readInstallState } from "../harness/install-state.js";
import type { WorkspaceState } from "../workflow/state.js";
import { type Check, inconsistentAuthorizationMarkers } from "./checks.js";

/**
 * Repairs what can be repaired without a decision. Anything that needs a
 * judgement call — which validation commands to run, whether to be a git
 * repository — is reported rather than guessed at.
 */

export interface Repair {
  readonly name: string;
  readonly done: boolean;
  readonly detail: string;
}

export async function applyFixes(
  state: WorkspaceState,
  checks: readonly Check[],
  runtime: InstallRuntime = {},
): Promise<Repair[]> {
  const repairs: Repair[] = [];
  const failing = new Set(
    checks.filter((check) => check.status !== "ok").map((check) => check.name),
  );

  const enforcement = failing.has("enforcement");
  if (failing.has("file transactions")) {
    const recovered = await recoverFileTransactions(state.paths.root);
    repairs.push({
      name: "file transactions",
      done: recovered.ok,
      detail: recovered.ok
        ? `Recovered ${recovered.value.length} interrupted transaction(s)`
        : recovered.error.message,
    });
  }
  if (failing.has("authorization markers")) {
    repairs.push(await clearInconsistentAuthorizations(state));
  }
  if (failing.has("harness assets") || failing.has("harness activation") || enforcement) {
    repairs.push(await reinstallAssets(state, enforcement, runtime));
  }
  if (failing.has("repository index")) repairs.push(await rebuildIndex(state));

  return repairs;
}

async function clearInconsistentAuthorizations(state: WorkspaceState): Promise<Repair> {
  const markers = await inconsistentAuthorizationMarkers(state);
  if (!markers.ok) {
    return { name: "authorization markers", done: false, detail: markers.error.message };
  }
  const mutations: FileMutation[] = [];
  for (const task of markers.value) {
    const path = state.paths.implementMarker(task);
    const current = await state.files.readBytesIfExists(path);
    if (!current.ok) {
      return { name: "authorization markers", done: false, detail: current.error.message };
    }
    const metadata = await state.files.metadata(path);
    if (!metadata.ok) {
      return { name: "authorization markers", done: false, detail: metadata.error.message };
    }
    mutations.push({
      kind: "remove",
      path,
      expectedBefore: filePrecondition(current.value, metadata.value?.mode),
    });
  }
  const cleared = await applyFileTransaction(
    state.paths.root,
    "doctor-clear-stale-authorizations",
    mutations,
  );
  return {
    name: "authorization markers",
    done: cleared.ok,
    detail: cleared.ok
      ? `Removed ${markers.value.length} stale authorization marker(s)`
      : cleared.error.message,
  };
}

/**
 * Repairing the assets without the hooks would leave the report green while
 * nothing actually refuses anything, so the enforcement surfaces are installed
 * in the same pass that found them missing.
 */
async function reinstallAssets(
  state: WorkspaceState,
  enforcement: boolean,
  runtime: InstallRuntime,
): Promise<Repair> {
  const preferences = await repairInstallPreferences(state);
  if (!preferences.ok) {
    return { name: "harness assets", done: false, detail: preferences.error.message };
  }

  const installed = await installHarness(
    state.paths,
    {
      harness: state.config.harness,
      profile: preferences.value.profile,
      hooks: preferences.value.hooks,
      mcp: preferences.value.mcp,
    },
    runtime,
  );

  if (!installed.ok) {
    return { name: "harness assets", done: false, detail: installed.error.message };
  }

  const written = installed.value.assets.filter((asset) => asset.status === "written");
  const enforcementState = installedEnforcement(
    installed.value,
    preferences.value.hooks,
    preferences.value.mcp,
    enforcement,
  );
  if (enforcementState.problem) {
    return { name: "harness assets", done: false, detail: enforcementState.problem };
  }

  const detail =
    written.length === 0
      ? "Already in place"
      : `Wrote ${written.length} file(s) for ${state.config.harness}`;

  return {
    name: "harness assets",
    done: true,
    detail:
      enforcementState.surfaces.length > 0
        ? `${detail}; enforced by ${enforcementState.surfaces.join(", ")}`
        : detail,
  };
}

interface RepairInstallPreferences {
  readonly profile: WorkspaceState["config"]["profile"];
  readonly hooks: readonly HookKind[];
  readonly mcp: boolean;
}

async function repairInstallPreferences(
  state: WorkspaceState,
): Promise<Result<RepairInstallPreferences>> {
  const recorded = await readInstallState(state.paths, state.files);
  if (!recorded.ok) return recorded;
  const preferences = recorded.value?.harness === state.config.harness ? recorded.value : undefined;
  return {
    ok: true,
    value: {
      profile: preferences?.profile ?? state.config.profile,
      hooks: preferences?.hooks ?? defaultHooks(state.config.harness),
      mcp: preferences?.mcp ?? mcpAware(state.config.harness),
    },
  };
}

function installedEnforcement(
  installed: InstallOutcome,
  hooks: readonly HookKind[],
  mcp: boolean,
  required: boolean,
): { readonly surfaces: string[]; readonly problem?: string } {
  if (!required || (hooks.length === 0 && !mcp)) return { surfaces: [] };
  if (installed.claudeSettings === "malformed") {
    return {
      surfaces: [],
      problem: `${CLAUDE_SETTINGS_FILE} is not valid JSON, so the edit hook could not be wired`,
    };
  }
  if (installed.claudeSettings === "customized") {
    return {
      surfaces: [],
      problem: `${CLAUDE_SETTINGS_FILE} contains an edited VISP hook registration`,
    };
  }

  const surfaces: string[] = [];
  if (hooks.includes("claude") && installed.claudeSettings) surfaces.push("edit hook");
  if (hooks.includes("git")) surfaces.push("pre-commit");
  if (installed.mcp && installed.mcp !== "malformed") surfaces.push("mcp");
  return { surfaces };
}

function mcpAware(harness: WorkspaceState["config"]["harness"]): boolean {
  return ["claude-code", "codex", "cursor", "opencode"].includes(harness);
}

async function rebuildIndex(state: WorkspaceState): Promise<Repair> {
  const present = await state.files.exists(state.paths.graphStore);
  if (!present.ok) {
    return { name: "repository index", done: false, detail: present.error.message };
  }
  const built = present.value ? refreshRepository : indexRepository;
  const report = await built(state.paths.root, state.config.graph, state.paths.graphStore);

  if (!report.ok) {
    return {
      name: "repository index",
      done: false,
      detail: `${report.error.message}. Try: ${PRODUCT_NAME} index`,
    };
  }

  return {
    name: "repository index",
    done: true,
    detail: report.value.noChange
      ? "Already current"
      : `Indexed ${report.value.counts.files} files`,
  };
}
