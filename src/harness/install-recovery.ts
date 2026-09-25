import { DEFAULT_PROFILE, type Harness } from "../core/constants.js";
import type { VispError } from "../core/errors.js";
import type { InstallOptions } from "./install-types.js";

const NATIVE_HOSTS: readonly Harness[] = ["codex", "claude-code", "cursor", "copilot"];

/** Preserve the original failure and transaction recovery; never change the requested host. */
export function installationRecovery(error: VispError, options: InstallOptions): VispError {
  if (!NATIVE_HOSTS.includes(options.harness) || !isHostAccessFailure(error)) return error;
  const retry = retryInstallCommand(options);
  const steps = [
    `Installation for ${options.harness} is incomplete. Inspect the failed path above. If the host sandbox restricts that path, use the host's permission approval flow for this installation command, or run it from a terminal with access to the project. For a missing path, check its parent directories before retrying.`,
    `Retry from the same project directory with the same options: ${retry}`,
    "Switching to --harness generic omits host-specific integration, including the critic agent profile. It is not a permission-recovery step and does not satisfy an enabled critic requirement.",
  ];
  return {
    ...error,
    message: [error.message, ...steps].join("\n"),
    details: {
      ...error.details,
      installationRecovery: { harness: options.harness, retry, setupIncomplete: true },
    },
  };
}

function isHostAccessFailure(error: VispError): boolean {
  if (error.code !== "IO_ERROR") return false;
  if (/\b(?:EACCES|EPERM|EROFS)\b/.test(error.message)) return true;
  // Some host sandboxes surface denied creation of protected directories as ENOENT.
  return (
    /\bENOENT\b/.test(error.message) &&
    /(?:^|[\\/'"])\.(?:agents|codex|claude|cursor|github)(?:[\\/'"]|$)/.test(error.message)
  );
}

function retryInstallCommand(options: InstallOptions): string {
  const hooks = options.hooks ?? [];
  return [
    "visp install",
    `--harness ${options.harness}`,
    `--profile ${options.profile ?? DEFAULT_PROFILE}`,
    hooks.length > 0 ? `--hooks ${hooks.join(" ")}` : "--no-hooks",
    ...(options.mcp === true ? [] : ["--no-mcp"]),
    ...(options.force ? ["--force"] : []),
    ...(options.prunePreviousHarness ? ["--prune-previous-harness"] : []),
  ].join(" ");
}
