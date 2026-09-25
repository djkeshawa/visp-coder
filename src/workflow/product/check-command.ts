import { basename } from "node:path";
import { recursiveCheckMutation } from "../../core/check-context.js";
import { vispError } from "../../core/errors.js";
import { describeCommand, resolveCommand } from "../../core/exec.js";
import { err, ok, type Result } from "../../core/result.js";
import {
  browserObservationMode,
  nonExecutingValidationMode,
  staticInspectionCommand,
  syntaxOnlyValidationMode,
} from "../evidence/command-quality.js";
import type { ProductCheck } from "./model.js";

type BrowserCheckCommand = Extract<ProductCheck["command"], { kind: "browser-journey" }>;
export function isBrowserCheckCommand(
  command: ProductCheck["command"],
): command is BrowserCheckCommand {
  return typeof command === "object" && !Array.isArray(command) && "kind" in command;
}

export function describeProductCheck(check: ProductCheck): string {
  return isBrowserCheckCommand(check.command)
    ? `browser-journey ${check.command.journey.url}`
    : describeCommand(check.command);
}

/** A passing check may prove syntax or source shape without exercising behavior. */
export function productCheckSupportsBehavior(check: ProductCheck): boolean {
  if (isBrowserCheckCommand(check.command)) return true;
  const resolved = resolveCommand(check.command);
  if (!resolved.ok) return false;
  return (
    nonExecutingValidationMode(resolved.value) === undefined &&
    syntaxOnlyValidationMode(resolved.value) === undefined &&
    staticInspectionCommand(resolved.value) === undefined &&
    browserObservationMode(resolved.value) === undefined
  );
}

/** Decode executable argv only. Test helpers are unrestricted until they request a mutation. */
export function validateProductCheckCommand(check: ProductCheck): Result<void> {
  if (isBrowserCheckCommand(check.command)) return ok(undefined);
  const command = resolveCommand(check.command);
  if (!command.ok)
    return err(
      vispError("ARTIFACT_INVALID", `Check ${check.id} cannot run: ${command.error.message}`),
    );
  return directWorkflowMutation(command.value)
    ? err(recursiveCheckMutation(check.id))
    : ok(undefined);
}

function directWorkflowMutation(argv: string[]): boolean {
  const executable = basename(argv[0] ?? "").replace(/\.(?:cmd|exe)$/i, "");
  let args = argv.slice(1);
  if (["pnpm", "npm", "yarn", "bun"].includes(executable) && args[0] === "exec")
    args = args.slice(1).filter((entry) => entry !== "--");
  else if (executable !== "npx") args = argv;
  if (basename(args[0] ?? "").replace(/\.(?:cmd|exe)$/i, "") !== "visp") return false;
  // --project can select a separate workspace; the canonical runtime guard decides it.
  if (args.some((entry) => entry === "--project" || entry.startsWith("--project="))) return false;
  const command = args.slice(1).find((entry) => !entry.startsWith("-"));
  if (command === "brief" || command === "review")
    return args.some(
      (entry) =>
        entry === "--from" ||
        entry.startsWith("--from=") ||
        (command === "brief" && (entry === "--patch" || entry.startsWith("--patch="))) ||
        (command === "review" && entry === "--dispatch"),
    );
  if (command === "work" && args.includes("--inspect")) return false;
  if ((command === "install" || command === "migrate") && args.includes("--dry-run")) return false;
  const mutations = new Set([
    "init",
    "setup",
    "install",
    "start",
    "feature",
    "context",
    "work",
    "capture",
    "control",
    "verify",
    "reproduce",
    "done",
    "accept",
    "refine",
    "migrate",
    "save",
    "checkpoint",
    "override",
  ]);
  return command !== undefined && mutations.has(command);
}
