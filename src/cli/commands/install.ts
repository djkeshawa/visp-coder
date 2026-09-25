import { Command } from "commander";
import {
  HARNESSES,
  type Harness,
  PRODUCT_NAME,
  PROFILES,
  type Profile,
} from "../../core/constants.js";
import { HOOK_KINDS, parseHarness, parseHookKind, parseProfile } from "../../core/input.js";
import { ok, type Result } from "../../core/result.js";
import {
  defaultHooks,
  type HookKind,
  type InstallOutcome,
  type InstallPreview,
  installHarness,
  previewHarnessInstall,
} from "../../harness/install.js";
import { isJson, mutatingWorkspace, options, workspace } from "../context.js";
import { emit, emitError } from "../output.js";

/** Harnesses with a project-level MCP configuration visp can merge safely. */
const MCP_AWARE: readonly Harness[] = ["claude-code", "codex", "cursor", "opencode"];

export function installCommand(): Command {
  return new Command("install")
    .description("Install visp assets and hooks into your AI coder")
    .option("--harness <name>", `Which coder (${HARNESSES.join(", ")})`)
    .option("--profile <name>", `How much always-resident text to install (${PROFILES.join(", ")})`)
    .option("--hooks <kind...>", `Which enforcement hooks (${HOOK_KINDS.join(", ")})`)
    .option("--no-hooks", "Install assets only, leaving nothing to enforce scope")
    .option("--no-mcp", "Skip registering visp as an MCP server")
    .option(
      "--dry-run",
      "Preview exact installation paths and setup requirements without writing or recovering state",
    )
    .option(
      "--prune-previous-harness",
      "Remove only fingerprint-matched VISP assets from other harnesses",
    )
    .option("--force", "Overwrite files that have been edited since install")
    .action(handleInstallCommand);
}

interface InstallCliOptions {
  readonly harness?: string;
  readonly profile?: string;
  readonly hooks?: string[] | boolean;
  readonly force?: boolean;
  readonly mcp?: boolean;
  readonly prunePreviousHarness?: boolean;
  readonly dryRun?: boolean;
}

async function handleInstallCommand(_flags: unknown, command: Command): Promise<void> {
  const opts = options<InstallCliOptions>(command);
  const choices = parseInstallChoices(opts);
  if (!choices.ok) {
    process.exitCode = emitError("install", choices.error, { json: isJson(opts) });
    return;
  }
  const state = opts.dryRun ? await workspace(opts) : await mutatingWorkspace(opts);
  if (!state.ok) {
    process.exitCode = emitError("install", state.error, { json: isJson(opts) });
    return;
  }

  const harness = choices.value.harness ?? state.value.config.harness;
  const profile = choices.value.profile ?? state.value.config.profile;
  const installOptions = {
    harness,
    profile,
    hooks: selectedHooks(choices.value.hooks, harness),
    mcp: opts.mcp !== false && MCP_AWARE.includes(harness),
    configUpdates: {
      ...(choices.value.harness ? { harness: choices.value.harness } : {}),
      ...(choices.value.profile ? { profile: choices.value.profile } : {}),
    },
    ...(opts.prunePreviousHarness ? { prunePreviousHarness: true } : {}),
    ...(opts.force ? { force: true } : {}),
  };
  if (opts.dryRun) {
    process.exitCode = emit(
      "install",
      await previewHarnessInstall(state.value.paths, installOptions),
      {
        json: isJson(opts),
        text: renderInstallPreview,
      },
    );
    return;
  }
  const result = await installHarness(state.value.paths, installOptions);

  const profileChanged = opts.profile !== undefined && opts.profile !== state.value.config.profile;
  process.exitCode = emit("install", result, {
    json: isJson(opts),
    text: (outcome) => renderInstallResult(outcome, profileChanged),
    nextCommand: () => `${PRODUCT_NAME} next`,
  });
}

interface ParsedInstallChoices {
  readonly harness?: Harness;
  readonly profile?: Profile;
  readonly hooks?: HookKind[] | boolean;
}

function parseInstallChoices(opts: InstallCliOptions): Result<ParsedInstallChoices> {
  const harness = opts.harness ? parseHarness(opts.harness) : undefined;
  if (harness && !harness.ok) return harness;
  const profile = opts.profile ? parseProfile(opts.profile) : undefined;
  if (profile && !profile.ok) return profile;

  const hooks = parseHooks(opts.hooks);
  if (!hooks.ok) return hooks;

  return ok({
    ...(harness?.ok ? { harness: harness.value } : {}),
    ...(profile?.ok ? { profile: profile.value } : {}),
    ...(hooks.value !== undefined ? { hooks: hooks.value } : {}),
  });
}

function parseHooks(
  values: string[] | boolean | undefined,
): Result<HookKind[] | boolean | undefined> {
  if (!Array.isArray(values)) return ok(values);
  const hooks: HookKind[] = [];
  for (const value of values) {
    const hook = parseHookKind(value);
    if (!hook.ok) return hook;
    hooks.push(hook.value);
  }
  return ok(hooks);
}

function selectedHooks(configured: HookKind[] | boolean | undefined, harness: Harness): HookKind[] {
  if (Array.isArray(configured)) {
    return configured as HookKind[];
  }
  return configured === false ? [] : defaultHooks(harness);
}

function renderInstallResult(outcome: InstallOutcome, profileChanged: boolean): string {
  const rendered = renderInstall(outcome);
  return profileChanged && (outcome.mcp === "added" || outcome.mcp === "replaced")
    ? `${rendered}\n\nThe MCP tool set follows the profile; restart your MCP client to pick it up.`
    : rendered;
}

function renderInstall(outcome: InstallOutcome): string {
  const lines = [
    `Installed visp assets for ${outcome.harness}:`,
    ...outcome.assets.map((asset) => `  ${describeStatus(asset.status)}  ${asset.path}`),
  ];

  if (outcome.mcp === "added" || outcome.mcp === "replaced") {
    lines.push(
      `  ${describeStatus("written")}  ${outcome.mcpConfigFile}  (registered as an MCP server)`,
    );
  }

  if (outcome.assets.some((asset) => asset.status === "skipped-modified")) {
    lines.push("", "Files you edited were left alone. Use --force to replace them.");
  }

  if (outcome.settingsSnippet) {
    lines.push(
      "",
      "Add this to .claude/settings.json to block out-of-scope edits as they happen:",
      "",
      outcome.settingsSnippet,
    );
  }

  if (outcome.manualSteps.length > 0) {
    lines.push("", ...outcome.manualSteps.map((step) => `- ${step}`));
  }
  lines.push("", ...outcome.requirements);

  return lines.join("\n");
}

function renderInstallPreview(outcome: InstallPreview): string {
  return [
    `Installation preview for ${outcome.harness} (${outcome.profile}); no files changed.`,
    ...outcome.changes.map((change) => `  ${change.operation}  ${change.path}`),
    ...(outcome.changes.length === 0 ? ["  Installed files are current."] : []),
    "",
    ...outcome.requirements,
    ...outcome.manualSteps,
  ].join("\n");
}

function describeStatus(status: string): string {
  if (status === "written") return "wrote  ";
  if (status === "unchanged") return "current";
  if (status === "removed") return "removed";
  return "kept   ";
}
