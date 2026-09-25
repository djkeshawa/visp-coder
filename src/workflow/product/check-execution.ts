import { randomUUID } from "node:crypto";
import { withProductCheckContext } from "../../core/check-context.js";
import { commandExecutableDigest } from "../../core/command-executable.js";
import { fromUnknown, vispError } from "../../core/errors.js";
import { type CommandOutput, resolveCommand, run } from "../../core/exec.js";
import type { FileMutation } from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { err, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { executeBrowserCheck } from "./browser-check-execution.js";
import {
  describeProductCheck,
  isBrowserCheckCommand,
  validateProductCheckCommand,
} from "./check-command.js";
import type { ProductCheck, ProductExecution, ProductSlice, ProductState } from "./model.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest, productSourceDigest } from "./subject.js";
import { productVerifierDigest } from "./verifier-identity.js";

export interface ExecutedProductCheck {
  readonly execution: ProductExecution;
  readonly state: ProductState;
  readonly mutations: FileMutation[];
}

export async function executeProductCheck(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  check: ProductCheck,
  subjectDigest: string,
  retryEnvironment = false,
  verifierSnapshot: Record<string, string> = {},
): Promise<ExecutedProductCheck> {
  const environment = await productSourceDigest(workspace, record.brief, {});
  const base = {
    id: randomUUID(),
    comparisonEnvironment: environment.ok ? environment.value : undefined,
    check: check.id,
    ...(slice ? { task: slice.id } : {}),
    subjectDigest,
    contractDigest: productContractDigest(record.brief, slice),
    createdAt: new Date().toISOString(),
    command: describeProductCheck(check),
    provenance: "supervisor-executed" as const,
    verifierDigest: productVerifierDigest(check, verifierSnapshot),
  };
  const unavailable = unavailableVerifier(check, base, record.state);
  if (unavailable) return unavailable;
  if (isBrowserCheckCommand(check.command))
    return executeBrowserCheck(workspace, record, check.command, base, retryEnvironment);
  const started = Date.now();
  const output = await executeCommand(workspace, check);
  const commandVerifier =
    base.verifierDigest && output.ok && output.value.executableDigest
      ? {
          version: 2 as const,
          verifier: base.verifierDigest,
          executable: output.value.executableDigest,
        }
      : undefined;
  return {
    execution: {
      ...base,
      ...(commandVerifier ? { commandVerifier } : {}),
      verifierDigest: commandVerifier ? hashValue(commandVerifier) : undefined,
      assertions: "agent-reported",
      status: commandStatus(output),
      exitCode: output.ok ? output.value.exitCode : -1,
      durationMs: output.ok ? output.value.durationMs : Date.now() - started,
      output: commandEvidenceOutput(output, !!base.verifierDigest),
    },
    state: record.state,
    mutations: [],
  };
}

function commandEvidenceOutput(
  output: Result<CommandOutput & { executableDigest?: string }>,
  verifierDeclared: boolean,
) {
  if (!output.ok) return output.error.message.slice(-8000);
  const text = `${output.value.stdout}\n${output.value.stderr}`.trim();
  const limitation =
    verifierDeclared && !output.value.executableDigest
      ? "VISP: executable identity was unavailable or changed during execution. This result cannot support a witnessed repair or disproof. Use a stable, readable executable on a qualified platform and rerun the relevant checks; do not treat this as a product failure."
      : "";
  const sandbox = output.value.exitCode !== 0 && sandboxDenied(output.value) ? SANDBOX_NOTE : "";
  return [text.slice(-(8000 - sandbox.length - 1)), limitation, sandbox]
    .filter(Boolean)
    .join("\n")
    .slice(-8000);
}

function unavailableVerifier(
  check: ProductCheck,
  base: ExecutionIdentity & Pick<ProductExecution, "verifierDigest">,
  state: ProductState,
): ExecutedProductCheck | undefined {
  if (check.verifierFiles?.length && !base.verifierDigest)
    return {
      execution: {
        ...base,
        assertions: isBrowserCheckCommand(check.command) ? "runner-observed" : "agent-reported",
        status: "environment-failed",
        exitCode: -1,
        durationMs: 0,
        output: `Check ${check.id} was not executed: verifier inputs are missing, unavailable, or omit an explicit Node assertion entry (${check.verifierFiles.join(", ")}). Use repository-relative Node script paths, declare the assertion entry and its helpers in verifierFiles, or restore missing files before rerunning. No product behavior was tested.`,
      },
      state,
      mutations: [],
    };
  return undefined;
}

export type ExecutionIdentity = Pick<
  ProductExecution,
  | "id"
  | "check"
  | "task"
  | "subjectDigest"
  | "contractDigest"
  | "createdAt"
  | "command"
  | "provenance"
>;

async function executeCommand(
  workspace: WorkspaceState,
  check: ProductCheck,
): Promise<Result<CommandOutput & { executableDigest?: string }>> {
  const valid = validateProductCheckCommand(check);
  if (!valid.ok) return valid;
  if (isBrowserCheckCommand(check.command))
    return err(fromUnknown("Browser checks must use the runner", "ARTIFACT_INVALID"));
  const argv = resolveCommand(check.command);
  if (!argv.ok) return err(fromUnknown(argv.error.message, "ARTIFACT_INVALID"));
  try {
    const result = await withProductCheckContext(
      workspace.paths.root,
      check.id,
      async (environment) => {
        const binary = argv.value[0] ?? "";
        const before = await commandExecutableDigest(binary, workspace.paths.root, environment);
        const executed = await run(binary, argv.value.slice(1), {
          cwd: workspace.paths.root,
          env: environment,
          replaceEnv: true,
        });
        if (!executed.ok) return executed;
        const after = await commandExecutableDigest(binary, workspace.paths.root, environment);
        return {
          ok: true as const,
          value: {
            ...executed.value,
            executableDigest: before && before === after ? before : undefined,
          },
        };
      },
    );
    if (!result.ok && result.error.details?.errno === "ENOENT")
      return err(
        vispError(
          "COMMAND_FAILED",
          `${result.error.message}. Check ${check.id} could not start executable ${JSON.stringify(argv.value[0])}. Correct the command or recover the installed executable in this environment. A check command is executable argv (for example ["node", "--test", "test/behavior.test.mjs"]), not a manual instruction; browser actions use {kind:"browser-journey", journey:{url, actions}}. Manual behavior descriptions belong in brief examples. No product behavior was tested.`,
          { details: result.error.details },
        ),
      );
    return result;
  } catch (cause) {
    return err(fromUnknown(cause, "COMMAND_FAILED"));
  }
}

function commandStatus(output: Result<CommandOutput>): ProductExecution["status"] {
  if (!output.ok) return "environment-failed";
  if (output.value.exitCode === 0 && !output.value.timedOut) return "passed";
  return sandboxDenied(output.value) ? "environment-failed" : "failed";
}

/**
 * Host sandboxes (for example Codex workspace-write) deny sockets to supervised checks
 * that the actor ran successfully with escalation. That is not a product failure.
 */
const SANDBOX_DENIAL =
  /socket\.py[\s\S]*PermissionError: \[Errno 1\] Operation not permitted|\b(?:listen|connect|bind) EPERM\b/;
const SANDBOX_NOTE =
  "VISP: the host sandbox denied network sockets to this check, so no product behavior was tested. Rerun the same visp command with the host's sandbox escalation (for Codex, request escalated permissions for that command); do not change the product to work around it.";

function sandboxDenied(output: CommandOutput): boolean {
  return SANDBOX_DENIAL.test(`${output.stdout}\n${output.stderr}`);
}
