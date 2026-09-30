import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withProductCheckContext } from "../../core/check-context.js";
import { commandExecutableDigest } from "../../core/command-executable.js";
import { fromUnknown, vispError } from "../../core/errors.js";
import { type CommandOutput, resolveCommand, run } from "../../core/exec.js";
import type { FileMutation } from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { outputRedactor, privatePath } from "../../core/redaction.js";
import { err, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { acceptanceEnvironment, privateTemporaryDirectory } from "./acceptance-environment.js";
import { executeBrowserCheck } from "./browser-check-execution.js";
import {
  describeProductCheck,
  isBrowserCheckCommand,
  validateProductCheckCommand,
} from "./check-command.js";
import { checkFix, missingAlias } from "./check-executable.js";
import { browserUnavailable } from "./environment.js";
import type {
  ProductBrief,
  ProductCheck,
  ProductExecution,
  ProductSlice,
  ProductState,
} from "./model.js";
import {
  environmentOnly,
  failingTests,
  pinnedWaivers,
  WAIVED_TESTS_ENV,
  type Waivers,
  waivedFailure,
} from "./pinned-dispute-model.js";
import { earlierAssertionResults } from "./review-check-output.js";
import { SANDBOX_NOTE, sandboxDenial } from "./sandbox-denial.js";
import type { ProductRecord } from "./store.js";
import { productComparisonEnvironmentDigest, productContractDigest } from "./subject.js";
import { productVerifierDigest } from "./verifier-identity.js";

export interface ExecutedProductCheck {
  readonly execution: ProductExecution;
  readonly state: ProductState;
  readonly mutations: FileMutation[];
}

/**
 * The comparison identity of one check's run. A command check hashes its own tool and the
 * environment it runs under; browser-journey checks pass no check, so the check run and its
 * capture run share one identity.
 */
export function checkComparisonEnvironment(
  workspace: WorkspaceState,
  brief: ProductBrief,
  check: ProductCheck,
) {
  return productComparisonEnvironmentDigest(
    workspace,
    brief,
    isBrowserCheckCommand(check.command) ? undefined : { check },
  );
}

export async function executeProductCheck(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  check: ProductCheck,
  subjectDigest: string,
  retryEnvironment = false,
  verifierSnapshot: Record<string, string> = {},
  signal?: AbortSignal,
  reuseCapture = false,
): Promise<ExecutedProductCheck> {
  const environment = await checkComparisonEnvironment(workspace, record.brief, check);
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
    return executeBrowserCheck(
      workspace,
      record,
      check.command,
      base,
      retryEnvironment,
      signal,
      check.timeoutMs,
      reuseCapture,
    );
  const started = Date.now();
  const argv = resolveCommand(check.command);
  const envFiles = argv.ok
    ? argv.value.flatMap((arg, index, args) =>
        arg.startsWith("--env-file=")
          ? [arg.slice("--env-file=".length)]
          : arg === "--env-file" && args[index + 1]
            ? [args[index + 1] as string]
            : [],
      )
    : [];
  const redact = await outputRedactor(workspace.paths.root, [
    ...envFiles,
    ...Object.keys(verifierSnapshot).filter((path) => privatePath(path)),
  ]);
  // Tests the independent reviewer found contradicting the request are skipped by the suite.
  const waivers = check.id.startsWith("PINNED_")
    ? await pinnedWaivers(workspace, record.brief.feature)
    : undefined;
  const output = await executeCommand(
    workspace,
    check,
    !!base.verifierDigest,
    signal,
    waiverEnvironment(waivers),
  );
  const raw = output.ok ? `${output.value.stdout}\n${output.value.stderr}` : output.error.message;
  const commandVerifier =
    base.verifierDigest && output.ok && output.value.executableDigest
      ? {
          version: 2 as const,
          verifier: base.verifierDigest,
          executable: output.value.executableDigest,
        }
      : undefined;
  // The recorded text is for reading and may leave lines out; waivers and disputes are decided
  // on the whole redacted output.
  const evidence = commandEvidenceOutput(
    output,
    !!base.verifierDigest,
    workspace.paths.root,
    redact,
  );
  const full = redact(raw);
  const decided = waivedResult(output, full, workspace.paths.root, waivers);
  const environmental = await environmentFailure(workspace, record, decided.status, waivers, full);
  const { status, note } = environmental
    ? { status: "environment-failed" as const, note: ENVIRONMENT_NOTE }
    : decided;
  return {
    execution: {
      ...base,
      ...(commandVerifier ? { commandVerifier } : {}),
      verifierDigest: commandVerifier ? hashValue(commandVerifier) : undefined,
      assertions: "agent-reported",
      status,
      exitCode: output.ok ? output.value.exitCode : -1,
      durationMs: output.ok ? output.value.durationMs : Date.now() - started,
      output: [note, evidence].filter(Boolean).join("\n"),
      ...(waivers ? { pinnedFailures: failingTests(full, waivers.declared) } : {}),
    },
    state: record.state,
    mutations: [
      {
        kind: "write",
        path: join(workspace.paths.sessionDir, "check-output", `${base.id}.log`),
        content: raw,
        mode: 0o600,
        expectedBefore: { existed: false },
      },
    ],
  };
}

function waiverEnvironment(waivers: Waivers | undefined): Record<string, string> {
  return waivers?.names.length ? { [WAIVED_TESTS_ENV]: JSON.stringify(waivers.names) } : {};
}

/** A suite that cannot skip tests fails on waived ones; VISP counts only that failure as passed. */
export function waivedResult(
  output: Result<CommandOutput & { executableDigest?: string }>,
  fullOutput: string,
  root: string,
  waivers: Waivers | undefined,
): { status: ProductExecution["status"]; note: string } {
  const status = commandStatus(output, root);
  return waivers && status === "failed" && waivedFailure(fullOutput, waivers)
    ? { status: "passed", note: waivedNote(waivers.names) }
    : { status, note: "" };
}

const ENVIRONMENT_NOTE =
  "VISP: the pinned suite reported an environment error and no failing test, and VISP's own check finds no browser that starts here, so this is not a product failure; no product behavior was tested.";

/**
 * A pinned run that failed only by printing `ENVIRONMENT ERROR:` is not a product failure,
 * but a product can print that line itself, so it needs corroboration the product cannot
 * forge: the run failed, printed no failing test and no uncaught error of any kind, and VISP
 * itself finds that no browser starts here (recorded for this environment, or a fresh probe).
 */
async function environmentFailure(
  workspace: WorkspaceState,
  record: ProductRecord,
  status: ProductExecution["status"],
  waivers: Waivers | undefined,
  output: string,
): Promise<boolean> {
  return (
    waivers !== undefined &&
    status === "failed" &&
    environmentOnly(output, waivers.declared) &&
    (await browserUnavailable(workspace.paths.root, record.state.browserCapability))
  );
}

function waivedNote(names: readonly string[]): string {
  return `VISP: every failing test was waived by the independent review (${names.join("; ")}); the suite cannot skip tests, so its exit status is not counted. Original output follows.`;
}

function commandEvidenceOutput(
  output: Result<CommandOutput & { executableDigest?: string }>,
  verifierDeclared: boolean,
  root: string,
  redact: (text: string) => string,
) {
  if (!output.ok)
    return [
      redact(output.error.message),
      sandboxDenial(output.error.message, root) ? SANDBOX_NOTE : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(-8000);
  const raw = `${output.value.stdout}\n${output.value.stderr}`.trim();
  const text = redact(raw);
  const limitation =
    verifierDeclared && !output.value.executableDigest
      ? "VISP: executable identity was unavailable or changed during execution. This result cannot support a witnessed repair or disproof. Use a stable, readable executable on a qualified platform and rerun the relevant checks; do not treat this as a product failure."
      : "";
  const sandbox = output.value.exitCode !== 0 && sandboxDenial(raw, root) ? SANDBOX_NOTE : "";
  const timeout = output.value.timedOut
    ? "VISP: check timed out; increase this check's timeoutMs or fix a stalled check before retrying. No passing product result was established."
    : "";
  const room = EVIDENCE_LIMIT - sandbox.length - timeout.length - 2;
  let budget = room;
  let block = text.length > room && /^\s*FAIL:/im.test(text) ? earlierFailLines(text, 0) : "";
  if (block) {
    // Leave space for the largest block and the notes so the final slice never cuts into it.
    budget = room - FAIL_BLOCK_LIMIT - limitation.length - 4;
  }
  const results = earlierAssertionResults(text, Math.max(0, budget - 2000), 2000, !!block);
  if (results) budget -= results.length + 1;
  const cutoff =
    !results && text.length > budget
      ? "VISP: earlier output omitted by the check evidence budget; inspect the local check-output log before judging unshown assertions."
      : "";
  budget -= cutoff.length + Number(cutoff.length > 0);
  // Named results and cutoff notes move the retained tail; failures must use that final cut.
  if (block) block = earlierFailLines(text, budget);
  return [block, results, cutoff, text.slice(-budget), limitation, timeout, sandbox]
    .filter(Boolean)
    .join("\n")
    .slice(-EVIDENCE_LIMIT);
}

const EVIDENCE_LIMIT = 8000;
const FAIL_BLOCK_LIMIT = 3000;
const FAIL_LINE_LIMIT = 300;
const FAIL_LINES_KEPT = 60;
const OMITTED_NOTE_ROOM = 200;

/**
 * Output is kept from its end, which drops `FAIL:` lines printed early in a long run; the
 * pinned-test view of a run (which tests failed, what may be disputed) needs every one.
 * Returns a block that repeats the dropped lines, or "" when none were dropped.
 */
function earlierFailLines(text: string, room: number): string {
  const cut = text.length - room;
  const end = text.indexOf("\n", cut);
  const kept = new Set(text.slice(end < 0 ? text.length : end).split(/\r?\n/));
  const dropped = [
    ...new Set(
      text
        .slice(0, end < 0 ? text.length : end)
        .split(/\r?\n/)
        .filter((line) => /^\s*FAIL:/i.test(line) && !kept.has(line))
        .map((line) => line.trim().slice(0, FAIL_LINE_LIMIT)),
    ),
  ];
  if (!dropped.length) return "";
  const block = ["VISP: FAIL lines from earlier in the output:"];
  for (const line of dropped.slice(0, FAIL_LINES_KEPT)) {
    if ([...block, line].join("\n").length > FAIL_BLOCK_LIMIT - OMITTED_NOTE_ROOM) break;
    block.push(line);
  }
  if (block.length === 1) return "";
  const omitted = dropped.length - (block.length - 1);
  if (omitted > 0)
    block.push(
      `VISP: ${omitted} more FAIL line${omitted === 1 ? " is" : "s are"} left out here; waiver and dispute decisions use the full output.`,
    );
  return block.join("\n");
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
        output: `Check ${check.id} was not executed: verifier inputs are missing, unavailable, or omit an explicit Node assertion entry (${check.verifierFiles.join(", ")}). If VISP could not identify the entry after a Node option, use --flag=value. Use repository-relative Node script paths, declare the assertion entry and its helpers in verifierFiles, or restore missing files before rerunning. No product behavior was tested.`,
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
  | "comparisonEnvironment"
>;

async function executeCommand(
  workspace: WorkspaceState,
  check: ProductCheck,
  identifyExecutable: boolean,
  signal?: AbortSignal,
  extraEnvironment: Record<string, string> = {},
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
      async (environment, directory) => {
        const binary = argv.value[0] ?? "";
        const checkEnvironment = check.id.startsWith("PINNED_")
          ? { ...(await privateAcceptanceEnvironment(environment, directory)), ...extraEnvironment }
          : environment;
        const before = identifyExecutable
          ? await commandExecutableDigest(binary, workspace.paths.root, checkEnvironment)
          : undefined;
        const executed = await run(binary, argv.value.slice(1), {
          cwd: workspace.paths.root,
          env: checkEnvironment,
          replaceEnv: true,
          timeoutMs: check.timeoutMs,
          signal,
        });
        if (!executed.ok) return executed;
        const after = before
          ? await commandExecutableDigest(binary, workspace.paths.root, checkEnvironment)
          : undefined;
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
        vispError("COMMAND_FAILED", missingCommandMessage(check, argv.value[0] ?? ""), {
          details: result.error.details,
        }),
      );
    return result;
  } catch (cause) {
    return err(fromUnknown(cause, "COMMAND_FAILED"));
  }
}

/** Short and specific: the worker's one next action, not a paragraph about environments. */
function missingCommandMessage(check: ProductCheck, argv0: string): string {
  const alias = missingAlias(argv0);
  const action = check.id.startsWith("PINNED_")
    ? "This pinned test is VISP's: do not edit it; run its command yourself with an installed interpreter and report the missing tool in your final message."
    : alias
      ? `Change the check: ${checkFix(check, argv0, alias)}, then run visp done.`
      : "Use an installed executable in the check (visp brief --patch -), then run visp done.";
  return [
    `missing-command: ${JSON.stringify(argv0)} is not installed in this environment${alias ? ` (${JSON.stringify(alias)} is)` : ""}.`,
    `Check ${check.id} was not run, so nothing about the product was tested.`,
    action,
    process.platform === "win32" ? "Check PATH and the tool's .cmd/.bat shim." : "",
    /\s/.test(argv0)
      ? 'A check command is executable argv (for example ["node", "--test", "test/behavior.test.mjs"]), not a manual instruction; browser actions use {kind:"browser-journey", journey:{url, actions}}. Manual behavior descriptions belong in brief examples.'
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A pinned run gets its own HOME and temporary directory inside the check's private
 * directory, which the check context removes: concurrent runs share no browser profile lock
 * and leave nothing behind. Ordinary checks keep the inherited HOME (npm and git need it).
 */
async function privateAcceptanceEnvironment(
  environment: Record<string, string>,
  directory: string,
): Promise<Record<string, string>> {
  const home = join(directory, "home");
  await mkdir(privateTemporaryDirectory(home), { recursive: true, mode: 0o700 });
  return acceptanceEnvironment(environment, home);
}

function commandStatus(output: Result<CommandOutput>, root: string): ProductExecution["status"] {
  if (!output.ok) return "environment-failed";
  if (output.value.timedOut) return "timed-out";
  if (output.value.exitCode === 0) return "passed";
  return sandboxDenial(`${output.value.stdout}\n${output.value.stderr}`, root) === "denied"
    ? "environment-failed"
    : "failed";
}
