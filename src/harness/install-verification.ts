import type { Harness, Profile } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import type { ProjectFileSystem } from "../core/fs.js";
import { isExecutableMode } from "../core/mode.js";
import type { ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import { pinnedRange, runtimeIdentity } from "../core/version.js";
import { agentActivationFile, planAgentActivation, requiresAgentActivation } from "./activation.js";
import { assetFingerprint } from "./asset-inspection.js";
import {
  CLAUDE_PRE_TOOL_USE_HOOK,
  CLAUDE_SETTINGS_FILE,
  preToolUseRegistration,
} from "./claude-settings.js";
import { preCommitHookPath } from "./git-hook.js";
import { verifyGuardHandshake } from "./guard-handshake.js";
import { renderCiWorkflow, renderPreCommitHook, renderPreToolUseHook } from "./hooks.js";
import { installStateText, readInstallState } from "./install-state.js";
import type { HookKind, InstallOptions, InstallPlan, InstallRuntime } from "./install-types.js";
import { mcpConfigFile as configFileForHarness, planMcpRegistration } from "./mcp-registration.js";
import { type Asset, planFor } from "./targets.js";

/** A successful install means every requested surface still matches after the transaction. */
export async function verifyInstalledHarness(
  paths: ProjectPaths,
  options: InstallOptions,
  profile: Profile,
  plan: InstallPlan,
  fs: ProjectFileSystem,
  runtime: InstallRuntime,
): Promise<Result<void>> {
  const assets = await verifyHarnessAssets(fs, plan, options.harness, profile);
  if (!assets.ok) return assets;
  const activation = await verifyHarnessActivation(fs, options.harness);
  if (!activation.ok) return activation;
  const hooks = await verifyRequestedHooks(fs, paths, options.hooks ?? []);
  if (!hooks.ok) return hooks;
  const mcp = await verifyRequestedMcp(fs, options);
  if (!mcp.ok) return mcp;
  const state = await verifyInstallState(paths, fs, options, profile);
  if (!state.ok) return state;
  const config = await verifyInstallConfig(paths, fs, plan.expectedConfig);
  if (!config.ok) return config;
  const manifest = await verifyInstallManifest(paths, fs, plan.expectedManifest);
  if (!manifest.ok) return manifest;
  return verifyLocalGuard(paths.root, options, runtime);
}

async function verifyHarnessAssets(
  fs: ProjectFileSystem,
  plan: InstallPlan,
  harness: Harness,
  profile: Profile,
): Promise<Result<void>> {
  const executablePaths = new Set(
    planFor(harness, profile)
      .assets.filter((asset) => asset.executable)
      .map((asset) => asset.path),
  );
  for (const [path, fingerprint] of Object.entries(plan.fingerprints)) {
    const current = await fs.readTextIfExists(path);
    if (!current.ok) return current;
    if (current.value === undefined || assetFingerprint(current.value) !== fingerprint) {
      return installMismatch("generated asset", path);
    }
    if (executablePaths.has(path)) {
      const metadata = await fs.metadata(path);
      if (!metadata.ok) return metadata;
      if (!isExecutableMode(metadata.value?.mode)) {
        return installMismatch("generated executable", path);
      }
    }
  }
  return ok(undefined);
}

async function verifyHarnessActivation(
  fs: ProjectFileSystem,
  harness: Harness,
): Promise<Result<void>> {
  if (!requiresAgentActivation(harness)) return ok(undefined);
  const current = await fs.readTextIfExists(agentActivationFile(harness));
  if (!current.ok) return current;
  const activation = planAgentActivation(harness, current.value, false);
  return activation.ok && activation.value.status === "current"
    ? ok(undefined)
    : installMismatch("harness activation", agentActivationFile(harness));
}

async function verifyRequestedHooks(
  fs: ProjectFileSystem,
  paths: ProjectPaths,
  hooks: readonly HookKind[],
): Promise<Result<void>> {
  for (const hook of new Set(hooks)) {
    const verified = await verifyRequestedHook(fs, paths, hook);
    if (!verified.ok) return verified;
  }
  return ok(undefined);
}

async function verifyRequestedMcp(
  fs: ProjectFileSystem,
  options: InstallOptions,
): Promise<Result<void>> {
  if (!options.mcp) return ok(undefined);
  const path = configFileForHarness(options.harness);
  const current = await fs.readTextIfExists(path);
  if (!current.ok) return current;
  const registration = planMcpRegistration(current.value, false, options.harness);
  return registration.ok && registration.value.status === "current"
    ? ok(undefined)
    : installMismatch("MCP registration", path);
}

async function verifyInstallState(
  paths: ProjectPaths,
  fs: ProjectFileSystem,
  options: InstallOptions,
  profile: Profile,
): Promise<Result<void>> {
  const installState = await readInstallState(paths, fs);
  if (!installState.ok) return installState;
  const expectedInstallState = {
    kind: "install-state" as const,
    version: 1 as const,
    harness: options.harness,
    profile,
    hooks: [...(options.hooks ?? [])],
    mcp: options.mcp === true,
    runtime: runtimeIdentity(),
  };
  if (JSON.stringify(installState.value) !== JSON.stringify(expectedInstallState)) {
    return installMismatch(
      "install state",
      paths.relative(paths.installState) ?? paths.installState,
    );
  }
  const raw = await fs.readTextIfExists(paths.installState);
  if (!raw.ok) return raw;
  if (raw.value !== installStateText(expectedInstallState)) {
    return installMismatch(
      "install state",
      paths.relative(paths.installState) ?? paths.installState,
    );
  }
  return ok(undefined);
}

async function verifyInstallConfig(
  paths: ProjectPaths,
  fs: ProjectFileSystem,
  expected: string | undefined,
): Promise<Result<void>> {
  const config = await fs.readTextIfExists(paths.config);
  if (!config.ok) return config;
  if (config.value !== expected) {
    return installMismatch("configuration", paths.relative(paths.config) ?? paths.config);
  }
  return ok(undefined);
}

async function verifyInstallManifest(
  paths: ProjectPaths,
  fs: ProjectFileSystem,
  expected: string,
): Promise<Result<void>> {
  const manifest = await fs.readTextIfExists(paths.assetManifest);
  if (!manifest.ok) return manifest;
  if (manifest.value !== expected) {
    return installMismatch(
      "asset manifest",
      paths.relative(paths.assetManifest) ?? paths.assetManifest,
    );
  }
  return ok(undefined);
}

async function verifyLocalGuard(
  root: string,
  options: InstallOptions,
  runtime: InstallRuntime,
): Promise<Result<void>> {
  const localEnforcementRequested = (options.hooks ?? []).some(
    (hook) => hook === "git" || hook === "claude",
  );
  return localEnforcementRequested
    ? (runtime.guardHandshake ?? verifyGuardHandshake)(root)
    : ok(undefined);
}

async function verifyGeneratedAsset(
  fs: ProjectFileSystem,
  asset: Asset,
  displayPath = asset.path,
): Promise<Result<void>> {
  const current = await fs.readTextIfExists(asset.path);
  if (!current.ok) return current;
  if (current.value !== asset.content) return installMismatch("generated asset", displayPath);
  if (!asset.executable) return ok(undefined);

  const metadata = await fs.metadata(asset.path);
  if (!metadata.ok) return metadata;
  return isExecutableMode(metadata.value?.mode)
    ? ok(undefined)
    : installMismatch("generated executable", displayPath);
}

async function verifyRequestedHook(
  fs: ProjectFileSystem,
  paths: ProjectPaths,
  hook: HookKind,
): Promise<Result<void>> {
  if (hook === "ci") {
    return verifyGeneratedAsset(fs, {
      path: ".github/workflows/visp.yml",
      content: renderCiWorkflow(pinnedRange()),
    });
  }
  if (hook === "git") {
    const resolved = await preCommitHookPath(paths.root);
    if (!resolved.ok) return resolved;
    return verifyGeneratedAsset(
      fs,
      {
        path: resolved.value.absolute,
        content: renderPreCommitHook(),
        executable: true,
      },
      resolved.value.display,
    );
  }

  const path = CLAUDE_PRE_TOOL_USE_HOOK;
  const script = await verifyGeneratedAsset(fs, {
    path,
    content: renderPreToolUseHook(),
    executable: true,
  });
  if (!script.ok) return script;
  const registration = await preToolUseRegistration(paths.root, path);
  return registration.ok && registration.value === "present"
    ? ok(undefined)
    : installMismatch("Claude hook registration", CLAUDE_SETTINGS_FILE);
}

function installMismatch(surface: string, path: string): Result<void> {
  return err(
    vispError("STAGE_BLOCKED", `The ${surface} did not pass post-install verification: ${path}`, {
      recovery: "visp doctor",
      details: { surface, path },
    }),
  );
}
