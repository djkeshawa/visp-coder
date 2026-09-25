import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveCriticPolicy } from "../../config/critic-defaults.js";
import { vispError } from "../../core/errors.js";
import { run } from "../../core/exec.js";
import { resolvedProductExecutionEnvironment } from "../../core/execution-environment.js";
import { applyFileTransaction, filePrecondition } from "../../core/file-transaction.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { matchesPattern } from "../../core/patterns.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import {
  createProductFeature,
  type ProductFeatureOptions,
  type ProductFeatureOutcome,
  updateProductBrief,
} from "./brief.js";
import { reachesModel, runCodexStructured, type SessionActivity } from "./critic-exec.js";
import { hostRequest } from "./host-prompts.js";
import { type ProductRecord, readProductRecord } from "./store.js";

/**
 * Independent acceptance tests. Before the first slice is authorized, a tester that never
 * sees the worker's code writes one executable test file from the original request alone.
 * VISP keeps it only when it has assertions and fails on the unimplemented project, then
 * pins it as protected intent: changing it needs an intent change the human reviewer sees.
 *
 * Why: frozen tests raise weak workers' correctness only when the tests are right, and
 * workers who write their own tests encode their own misreadings. Tests written from the
 * specification by a separate model and checked to fail first are the strongest available
 * signal a worker cannot quietly weaken (see docs/research-summary.md).
 */

const RECORD = "acceptance-tests.json";
const TESTER_TIMEOUT_MS = 720_000;
const BASELINE_TIMEOUT_MS = 120_000;
const STALE_RUNNING_MS = 10 * 60_000;
const MAX_FILE_BYTES = 64 * 1024;
const MIN_ASSERTIONS = 3;

const testerResponseSchema = z.object({
  file: z.object({ name: z.string(), content: z.string() }).nullable(),
  existingBehavior: z.boolean().default(false),
  tests: z.array(z.object({ name: z.string(), quote: z.string() })),
  notes: z.string(),
});
type TesterResponse = z.infer<typeof testerResponseSchema>;

/** Codex structured output needs every property required and no extra properties. */
const TESTER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["file", "existingBehavior", "tests", "notes"],
  properties: {
    existingBehavior: { type: "boolean" },
    file: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["name", "content"],
          properties: { name: { type: "string" }, content: { type: "string" } },
        },
        { type: "null" },
      ],
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quote"],
        properties: { name: { type: "string" }, quote: { type: "string" } },
      },
    },
    notes: { type: "string" },
  },
} as const;

export const independentTestsRecordSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["running", "pinned", "rejected", "failed", "declined"]),
    startedAt: z.string(),
    /** The writing process; a host that ends it (Codex's sandbox does) leaves no result. */
    pid: z.number().int().optional(),
    finishedAt: z.string().optional(),
    model: z.string().optional(),
    reason: z.string().optional(),
    file: z.string().optional(),
    command: z.array(z.string()).optional(),
    tests: z.array(z.object({ name: z.string(), quote: z.string() })).optional(),
    notes: z.string().optional(),
    content: z.string().optional(),
    baseline: z
      .object({ exitCode: z.number(), timedOut: z.boolean(), output: z.string() })
      .optional(),
  })
  .strict();
export type IndependentTestsRecord = z.infer<typeof independentTestsRecordSchema>;

/** What `work` tells the worker about the pinned tests. */
export interface IndependentTestsSummary {
  readonly status: IndependentTestsRecord["status"];
  readonly file?: string;
  readonly command?: readonly string[];
  readonly reason?: string;
  readonly instructions?: string;
}

export interface TesterRequest {
  readonly root: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly prompt: string;
  readonly schema: unknown;
  /** Work in a disposable writable copy where the existing program can be run. */
  readonly explore?: boolean;
  /** Paths left out of that copy (`workflow.blockedPaths`), besides common secret files. */
  readonly blockedPaths?: readonly string[];
  /** Receives the session's commands and web searches, for the human reviewer. */
  readonly onActivity?: (activity: SessionActivity) => void | Promise<void>;
}
/** Returns the tester's raw structured answer; throws when the tester could not run. */
export type IndependentTester = (request: TesterRequest) => Promise<unknown>;
/** Starts the tester for a feature and reports its record once finished or after `waitMs`. */
export type TestsStarter = (
  workspace: WorkspaceState,
  feature: string,
  waitMs: number,
) => Promise<Result<IndependentTestsRecord>>;

/**
 * Testers usually return in 1–3 minutes. The CLI stays under the 2-minute shell timeout
 * common agent hosts apply; MCP stays under the ~60 s tool-call timeout. `work` asks the
 * worker to run it again while the tester is still writing.
 */
const TESTS_WAIT_MS = { cli: 100_000, mcp: 50_000 } as const;

export function testsWaitMs(workspace: WorkspaceState, channel: "cli" | "mcp"): number {
  return workspace.config.critic?.launch === "codex-exec" ? TESTS_WAIT_MS[channel] : 0;
}

/** The tester VISP launches for this project, or undefined when it launches no model. */
export function configuredTestsStarter(
  workspace: WorkspaceState,
  channel: "cli" | "mcp" = "cli",
): TestsStarter | undefined {
  if (workspace.config.critic?.launch !== "codex-exec") return undefined;
  // Codex's sandbox ends every process a shell command started, so a detached tester never
  // finished there; a Codex worker's CLI runs it inside `visp feature` instead. The MCP
  // server outlives each call, so it keeps the background process.
  if (channel === "cli" && workspace.config.harness === "codex") return inlineTests(codexTester());
  // Bundled builds place the CLI entry beside this chunk; source runs test inline.
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  return existsSync(cli) ? backgroundTests(cli) : inlineTests(codexTester());
}

export function codexTester(
  options: { executable?: string; lookup?: (host: string) => Promise<unknown> } = {},
): IndependentTester {
  return async (request) => {
    const { lookup: dnsLookup } = await import("node:dns/promises");
    if (!(await reachesModel(options.lookup ?? ((host) => dnsLookup(host)))))
      throw new Error("The tester cannot reach its model from this process");
    const directory = await mkdtemp(join(tmpdir(), "visp-tester-"));
    try {
      const root = request.explore
        ? await repositoryCopy(request.root, directory, request.blockedPaths ?? [])
        : request.root;
      return await runCodexStructured({
        ...(options.executable ? { executable: options.executable } : {}),
        root,
        ...(request.explore ? { sandbox: "workspace-write" as const, network: true } : {}),
        directory,
        model: request.model,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        schema: request.schema,
        prompt: request.prompt,
        signal: AbortSignal.timeout(TESTER_TIMEOUT_MS),
        ...(request.onActivity ? { onActivity: request.onActivity } : {}),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export function inlineTests(tester: IndependentTester): TestsStarter {
  return (workspace, feature) => writeIndependentTests(workspace, feature, tester);
}

/**
 * The tester runs in a detached VISP process so an MCP call or a host that kills long
 * shell commands does not lose it; `work` waits up to its channel's limit for the record.
 */
export function backgroundTests(cli: string): TestsStarter {
  return async (workspace, feature, waitMs) => {
    const logPath = join(await mkdtemp(join(tmpdir(), "visp-tester-")), "tester.json");
    const output = openSync(logPath, "w");
    const child = spawn(
      process.execPath,
      [
        cli,
        "--project",
        workspace.paths.root,
        "work",
        "--feature",
        feature,
        "--write-tests",
        "--json",
      ],
      { detached: true, stdio: ["ignore", output, output] },
    );
    closeSync(output);
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    child.unref();
    const deadline = Date.now() + waitMs;
    let record = await readTestsRecord(workspace, feature);
    while (record.ok && !record.value && !exited && Date.now() < deadline) {
      await sleep(250);
      record = await readTestsRecord(workspace, feature);
    }
    if (!record.ok) return record;
    if (record.value)
      return ok(await waitForRecord(workspace, feature, deadline - Date.now(), record.value));
    if (!exited) return ok({ version: 1, status: "running", startedAt: new Date().toISOString() });
    const log = (await readFile(logPath, "utf8").catch(() => "")).slice(-600);
    return err(
      vispError("COMMAND_FAILED", `The independent tester exited before starting: ${log}`),
    );
  };
}

/**
 * Called by `work` before authorization. Pinning changes the slice contract, so the tests
 * must exist before the first slice is authorized, never in the middle of one.
 */
export async function independentTestsBeforeWork(
  workspace: WorkspaceState,
  feature: string | undefined,
  starter: TestsStarter | undefined,
  waitMs: number,
): Promise<Result<IndependentTestsSummary | undefined>> {
  if (!starter) return ok(undefined);
  const loaded = await readProductRecord(workspace, feature ? { feature } : {});
  if (!loaded.ok) return ok(undefined);
  const { brief } = loaded.value;
  if (!hasFunctionalOutcome(brief)) return ok(undefined);
  const existing = await readTestsRecord(workspace, brief.feature);
  if (!existing.ok) return existing;
  let record = existing.value;
  // Workers waited 1–2 minutes here. Pinned tests are not part of a slice's contract, so
  // work proceeds and the tests are pinned whenever the tester finishes.
  if (!record) {
    if (!(await testerLaunches(workspace, loaded.value))) return ok(undefined);
    const started = await starter(workspace, brief.feature, waitMs);
    if (!started.ok) return started;
    record = started.value;
  }
  return ok(summary(record));
}

/**
 * `feature` starts the tester, which needs only the original request, so it writes while
 * the worker drafts the brief; `work` then usually finds the tests ready.
 */
export async function startIndependentTests(
  workspace: WorkspaceState,
  feature: string,
  starter: TestsStarter | undefined,
): Promise<void> {
  if (!starter) return;
  const loaded = await readProductRecord(workspace, { feature });
  const existing = await readTestsRecord(workspace, feature);
  if (!loaded.ok || !existing.ok || existing.value) return;
  if (await testerLaunches(workspace, loaded.value)) await starter(workspace, feature, 0);
}

/** `visp feature`, then the tester in the background when VISP launches one. */
export async function createProductFeatureWithTests(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
  starter: TestsStarter | undefined,
): Promise<Result<ProductFeatureOutcome>> {
  // A worker's one-line summary would become the only contract the tester and reviewer see.
  const recorded = await hostRequest(workspace, options.sourceBrief);
  if (starter && !options.sourceBrief?.trim() && !(recorded.ok && recorded.value))
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Pass the user's complete request, verbatim, as the source brief: the independent tester and reviewer judge the work against it alone",
        {
          recovery: `visp feature "${options.goal.replaceAll('"', "'").slice(0, 80)}" --source-brief - (pipe the complete request on stdin)`,
        },
      ),
    );
  const created = await createProductFeature(workspace, options);
  if (created.ok) await startIndependentTests(workspace, created.value.brief.feature, starter);
  return created;
}

const SOURCE_FILE =
  /\.(py|mjs|cjs|js|jsx|ts|tsx|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|ex|exs|sh)$/;
const EXISTING_CODE_FILES = 3;
const TOOLING = /^(\.visp|\.claude|\.agents|\.codex|\.github|\.specify|_bmad|node_modules)\//;

/**
 * New projects by default. On an existing codebase, read-only testers assumed routes, error
 * formats and setup the code does not have, and workers changed correct code to satisfy
 * them. With `critic.existingCodeTests: true` the tester runs the existing program in a
 * disposable copy and must pass tests of existing behavior first; in trials 11 of 14 pinned
 * suites were correct; the rest assumed wrong setup, status codes or error bodies, so it
 * stays opt-in.
 */
async function existingCode(root: string): Promise<boolean> {
  const listed = await run("git", ["ls-files"], { cwd: root, timeoutMs: 10_000 });
  if (!listed.ok || listed.value.exitCode !== 0) return false;
  // A few files are a scaffold; the trial codebase had seven source files.
  const sources = listed.value.stdout
    .split("\n")
    .filter((path) => SOURCE_FILE.test(path) && !TOOLING.test(path));
  return sources.length >= EXISTING_CODE_FILES;
}

function hasFunctionalOutcome(brief: ProductRecord["brief"]): boolean {
  return brief.outcomes.some((outcome) => outcome.kind === "functional");
}

/** Once per feature, when the project pins no acceptance checks of its own. */
async function testerLaunches(workspace: WorkspaceState, record: ProductRecord): Promise<boolean> {
  if (record.brief.acceptanceBaseline.length || record.state.status === "accepted") return false;
  if (
    workspace.config.critic?.existingCodeTests !== true &&
    (await existingCode(workspace.paths.root))
  )
    return false;
  const policy = await resolveCriticPolicy(workspace.config.harness, workspace.config.critic);
  return policy.ok && policy.value.enabled && policy.value.config?.harness === "codex";
}

function summary(record: IndependentTestsRecord): IndependentTestsSummary {
  if (record.status === "running")
    return isStale(record)
      ? {
          status: "failed",
          reason:
            "The tester stopped without a result; the host may end background processes when a command finishes",
        }
      : {
          status: "running",
          instructions:
            "An independent tester is writing acceptance tests from the original request. Keep working; visp done reports them once they are pinned.",
        };
  return {
    status: record.status,
    ...(record.file ? { file: record.file } : {}),
    ...(record.command ? { command: record.command } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.status === "pinned"
      ? {
          instructions:
            "These acceptance tests were written from the original request by an independent tester and are pinned: do not edit them. Run them while you work; `done` on the last slice and `accept` run them. If one contradicts the request, record an intent change that quotes the request instead of weakening it.",
        }
      : {}),
  };
}

/** Runs the tester, keeps its file only if it fails on the current project, and pins it. */
export async function writeIndependentTests(
  workspace: WorkspaceState,
  feature: string,
  tester: IndependentTester,
): Promise<Result<IndependentTestsRecord>> {
  const existing = await readTestsRecord(workspace, feature);
  if (!existing.ok) return existing;
  if (existing.value && (existing.value.status !== "running" || !isStale(existing.value)))
    return ok(existing.value);
  const loaded = await readProductRecord(workspace, { feature });
  if (!loaded.ok) return loaded;
  const policy = await resolveCriticPolicy(workspace.config.harness, workspace.config.critic);
  if (!policy.ok) return policy;
  const model = policy.value.config?.model;
  if (!model) return err(vispError("CONFIG_INVALID", "The tester needs a configured critic model"));
  const startedAt = new Date().toISOString();
  const running: IndependentTestsRecord = {
    version: 1,
    status: "running",
    startedAt,
    model,
    pid: process.pid,
  };
  const marked = await saveTestsRecord(workspace, feature, running, existing.value);
  if (!marked.ok) return marked;
  const existingCodebase = await existingCode(workspace.paths.root);
  const request = {
    root: workspace.paths.root,
    model,
    ...testerEffort(policy.value.config?.reasoningEffort),
    prompt: testerPrompt(loaded.value.brief.originalRequest, feature, existingCodebase),
    schema: TESTER_OUTPUT_SCHEMA,
    ...(existingCodebase
      ? { explore: true, blockedPaths: workspace.config.workflow.blockedPaths }
      : {}),
    onActivity: (activity: SessionActivity) =>
      recordTesterActivity(workspace, feature, model, existingCodebase, activity),
  };
  const fields = await testOutcome(workspace, feature, tester, request);
  const record = { ...running, ...fields, finishedAt: new Date().toISOString() };
  const saved = await saveTestsRecord(workspace, feature, record, running);
  return saved.ok ? ok(independentTestsRecordSchema.parse(record)) : saved;
}

type TestFields = Partial<IndependentTestsRecord>;

async function testOutcome(
  workspace: WorkspaceState,
  feature: string,
  tester: IndependentTester,
  request: TesterRequest,
): Promise<TestFields> {
  const first = await attemptTests(workspace, feature, tester, request);
  if (first.status !== "rejected" || !first.content) return first;
  // Execution feedback: live suites on an existing codebase assumed routes and formats the
  // code does not have. One repair round with the failure output, then the same checks.
  return attemptTests(workspace, feature, tester, {
    ...request,
    prompt: repairPrompt(request.prompt, first.content, first.reason ?? ""),
  });
}

async function attemptTests(
  workspace: WorkspaceState,
  feature: string,
  tester: IndependentTester,
  request: TesterRequest,
): Promise<TestFields> {
  let response: TesterResponse;
  try {
    response = testerResponseSchema.parse(await tester(request));
  } catch (cause) {
    return { status: "failed", reason: message(cause) };
  }
  const described = { tests: response.tests, notes: response.notes };
  if (!response.file)
    return { status: "declined", reason: "No testable interface in the request", ...described };
  // The rejected file stays in the record so a person can see what the tester wrote.
  const content = response.file.content.slice(0, MAX_FILE_BYTES);
  const invalid = invalidFile(response.file);
  if (invalid) return { status: "rejected", reason: invalid, content, ...described };
  const kept = await keepFailingTests(workspace, feature, response.file, response.existingBehavior);
  return { ...kept, ...(kept.status === "rejected" ? { content } : {}), ...described };
}

function repairPrompt(prompt: string, content: string, reason: string): string {
  return [
    prompt,
    "",
    "Your previous file was rejected when VISP ran it against the current repository:",
    reason,
    "",
    "Previous file:",
    content,
    "",
    "Read the repository and the failure again, then return the whole corrected file. Keep only assertions the request or the repository supports.",
  ].join("\n");
}

/** Writes the file, keeps it only if it fails on the unimplemented project, and pins it. */
async function keepFailingTests(
  workspace: WorkspaceState,
  feature: string,
  file: { name: string; content: string },
  existingBehavior: boolean,
): Promise<TestFields> {
  const path = `acceptance/${feature}/${file.name}`;
  const command = testCommand(path);
  const written = await applyFileTransaction(workspace.paths.root, "write-acceptance-tests", [
    {
      kind: "write",
      path: join(workspace.paths.root, path),
      content: file.content,
      expectedBefore: { existed: false },
    },
  ]);
  if (!written.ok) return { status: "rejected", reason: written.error.message, file: path };
  const baseline = await runBaseline(workspace.paths.root, command);
  const kept = { file: path, command, baseline };
  // On an existing codebase the current code is the oracle for documented behavior: tests
  // of it, with the same helpers, must pass now. Wrong assumed formats fail here.
  const existing = existingBehavior
    ? await runBaseline(workspace.paths.root, command, { VISP_TEST_SCOPE: "existing" })
    : undefined;
  const rejection =
    existing && (existing.exitCode !== 0 || existing.timedOut)
      ? `Tests of existing behavior fail on the current repository, so the suite assumes something the code does not do: ${existing.output.slice(-600)}`
      : baseline.timedOut
        ? "The tests did not finish on the unimplemented project"
        : baseline.exitCode === 0
          ? "The tests pass before any implementation, so they check nothing new"
          : undefined;
  if (rejection) {
    await removeFile(workspace, path, file.content);
    return { status: "rejected", reason: rejection, content: file.content, ...kept };
  }
  const pinned = await pinTests(workspace, feature, path, command, file.content);
  if (pinned.ok) return { status: "pinned", ...kept };
  await removeFile(workspace, path, file.content);
  return { status: "failed", reason: pinned.error.message, ...kept };
}

/**
 * At high effort the tester took 4–5 minutes and once exceeded its deadline; tests from
 * a written contract need less deliberation than review of an implementation.
 */
function testerEffort(configured: string | undefined) {
  if (!configured) return {};
  return { reasoningEffort: configured === "low" ? "low" : "medium" };
}

export const TESTER_ACTIVITY_FILE = "tester-activity.jsonl";

/**
 * Monitoring for the tester: one JSON line per session in the feature's directory. With
 * network (execution mode) its commands appear in `visp pr`. Logging never fails the tester.
 */
async function recordTesterActivity(
  workspace: WorkspaceState,
  feature: string,
  model: string,
  network: boolean,
  activity: SessionActivity,
): Promise<void> {
  const line = `${JSON.stringify({ at: new Date().toISOString(), model, network, ...activity })}\n`;
  await appendFile(workspace.paths.featureFile(feature, TESTER_ACTIVITY_FILE), line).catch(
    () => undefined,
  );
}

/** Commands the tester ran with network access, per session, oldest first. */
export async function testerNetworkCommands(
  workspace: WorkspaceState,
  feature: string,
): Promise<{ at: string; commands: string[] }[]> {
  const text = await workspace.files.readTextIfExists(
    workspace.paths.featureFile(feature, TESTER_ACTIVITY_FILE),
  );
  if (!text.ok || !text.value) return [];
  return text.value.split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { at?: string; network?: boolean; commands?: string[] };
      return entry.network && entry.commands?.length
        ? [{ at: entry.at ?? "", commands: entry.commands }]
        : [];
    } catch {
      return [];
    }
  });
}

/** Never copied for a session with network, whatever the project's settings say. */
const SECRET_FILES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".npmrc",
  ".pypirc",
  ".netrc",
];

/** Like .gitignore: a pattern without a slash matches a name at any depth. */
function leftOut(path: string, patterns: readonly string[]): boolean {
  const parts = path.split("/");
  return patterns.some((pattern) =>
    parts.some((_, index) => {
      const prefix = parts.slice(0, index + 1).join("/");
      return (
        matchesPattern(prefix, pattern) ||
        (!pattern.includes("/") && matchesPattern(basename(prefix), pattern))
      );
    }),
  );
}

/**
 * A disposable copy of the tracked and untracked project files, without VISP state, blocked
 * paths or secret files, where the tester may run the existing program with network. The
 * real project is never written.
 */
async function repositoryCopy(
  root: string,
  directory: string,
  blockedPaths: readonly string[],
): Promise<string> {
  const copy = join(directory, "repository");
  const listed = await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    timeoutMs: 20_000,
  });
  const files = listed.ok ? listed.value.stdout.split("\0").filter(Boolean) : [];
  const excluded = [...SECRET_FILES, ...blockedPaths];
  for (const path of files) {
    if (path.startsWith(".visp/") || path.startsWith("acceptance/")) continue;
    if (leftOut(path, excluded)) continue;
    await mkdir(dirname(join(copy, path)), { recursive: true });
    await copyFile(join(root, path), join(copy, path)).catch(() => undefined);
  }
  return copy;
}

function testerPrompt(request: string, feature: string, existing = false): string {
  return [
    "You are an independent acceptance tester. Another agent will implement the request below after you finish; you will never see its code and it cannot change your tests.",
    "Write ONE self-contained executable test file that checks the observable behavior the request specifies.",
    "Rules:",
    "- Test only behavior the request states. Quote the sentence each test relies on in `tests[].quote`. Do not invent requirements, messages or formats the request leaves open.",
    "- A wrong test is worse than a missing one: the implementer must satisfy it. Leave out any case where a careful reader could expect a different result (for example extra fields or an empty body when the request does not say).",
    "- Reach the program only through interfaces the request names (commands, scripts, HTTP routes, files, exported names). If it names none a test could use, return file: null and explain in notes.",
    "- Use only the standard library: Python 3 (name ending .py, run as `python3 <file>`) or Node.js ES modules (name ending .mjs, run as `node <file>`). Prefer the language the request or repository uses.",
    "- Start and stop anything the tests need, the way the request says, with timeouts on every wait. Use a free port where one is needed.",
    "- Express every check as an assertion (Python `assert` or unittest assertions; Node `node:assert`). Exit non-zero when any test fails, and print which test failed and why.",
    "- The project is not implemented yet, so the file must fail now and pass once the request is met.",
    "- Before answering, check every case against the request and trace it through your own helpers (for example, how a missing body, None or null is actually sent). Remove any case you cannot justify from the quoted text.",
    "- Keep it focused: one test per stated rule or error case, at most about 30 tests and 500 lines.",
    ...(existing
      ? [
          "- This request changes an existing codebase, and you are in a disposable copy of it where you may run the existing program and its tests. Before asserting anything about existing behavior (routes, status codes, body shapes, error formats, the requests your setup makes), run the program and observe it; base every such assertion on what you observed, not on assumptions.",
          "- Create every item, record or file your tests need through the documented interfaces; never depend on data, fixtures or documentation examples already in the repository.",
          "- Include tests of existing behavior that use the same helpers as the new tests: at least one for every existing route, command or interface your new tests call or assert on (for example, if a new test expects a status from an existing endpoint, also test that endpoint's documented existing case), and every assertion helper the new tests use (such as an error-body check) must also be used by at least one existing-behavior test. Set existingBehavior: true. When the environment variable VISP_TEST_SCOPE is `existing`, run only those tests; they must pass on the repository as it is now. Your file is judged by running it against the real repository.",
        ]
      : ["- Set existingBehavior: false."]),
    `The file will be saved as acceptance/${feature}/<name> and run from the repository root. Do not modify the repository.`,
    "",
    "Request:",
    request,
  ].join("\n");
}

/** A frozen test is only as good as its assertions; reject what cannot fail usefully. */
function invalidFile(file: { name: string; content: string }): string | undefined {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(py|mjs)$/.test(file.name))
    return `Unsupported test file name ${JSON.stringify(file.name)}`;
  if (Buffer.byteLength(file.content) > MAX_FILE_BYTES) return "The test file is too large";
  const assertions = file.content.match(/\bassert\w*|AssertionError/g)?.length ?? 0;
  if (assertions < MIN_ASSERTIONS)
    return `The test file has ${assertions} assertions; at least ${MIN_ASSERTIONS} are required`;
  return undefined;
}

function testCommand(path: string): string[] {
  return path.endsWith(".py") ? ["python3", path] : ["node", path];
}

/**
 * One run of the pinned or candidate tests, in its own process group that is ended
 * afterwards: suites start servers, and one left two running after it finished.
 */
async function runBaseline(root: string, command: string[], extra: Record<string, string> = {}) {
  const [file, ...args] = command as [string, ...string[]];
  const env = await resolvedProductExecutionEnvironment();
  return new Promise<{ exitCode: number; timedOut: boolean; output: string }>((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn(file, args, {
      cwd: root,
      env: { ...env, VISP_ACCEPTANCE_BASELINE: "1", ...extra },
      // Its own process group on POSIX; on Windows detached would open a new console.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const endGroup = () => {
      try {
        // Windows has no process groups to signal; there the child itself is ended.
        if (process.platform === "win32") child.kill("SIGKILL");
        else if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group already exited.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      endGroup();
    }, BASELINE_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, timedOut: false, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      endGroup();
      resolve({ exitCode: code ?? -1, timedOut, output: output.trim().slice(-2000) });
    });
  });
}

async function pinTests(
  workspace: WorkspaceState,
  feature: string,
  path: string,
  command: string[],
  content: string,
) {
  // The worker may revise the brief meanwhile; never overwrite a concurrent revision.
  for (let attempt = 0; ; attempt += 1) {
    const current = await readProductRecord(workspace, { feature });
    if (!current.ok) return current;
    // Accepted work is not reopened by tests that arrive afterwards.
    if (current.value.state.status === "accepted")
      return err(
        vispError("STAGE_BLOCKED", "The feature was accepted before the tests were ready"),
      );
    const pinned = await pinOnto(workspace, current.value.brief, path, command, content);
    if (pinned.ok || pinned.error.code !== "STATE_BUSY" || attempt >= 4) return pinned;
  }
}

function pinOnto(
  workspace: WorkspaceState,
  brief: ProductRecord["brief"],
  path: string,
  command: string[],
  content: string,
) {
  return updateProductBrief(workspace, {
    feature: brief.feature,
    expectedBriefDigest: hashValue(brief),
    brief: {
      ...brief,
      acceptanceBaseline: [
        ...brief.acceptanceBaseline,
        { command, files: [{ path, sha256: sha256(content) }] },
      ],
    },
    intentChange: {
      reason: "Pin acceptance tests an independent tester wrote from the original request",
      provenance: "visp-tester",
    },
  });
}

async function removeFile(workspace: WorkspaceState, path: string, content: string) {
  await applyFileTransaction(workspace.paths.root, "discard-acceptance-tests", [
    {
      kind: "remove",
      path: join(workspace.paths.root, path),
      expectedBefore: filePrecondition(content),
    },
  ]);
}

export async function readTestsRecord(
  workspace: WorkspaceState,
  feature: string,
): Promise<Result<IndependentTestsRecord | undefined>> {
  const text = await workspace.files.readTextIfExists(workspace.paths.featureFile(feature, RECORD));
  if (!text.ok) return text;
  if (text.value === undefined) return ok(undefined);
  try {
    return ok(independentTestsRecordSchema.parse(JSON.parse(text.value)));
  } catch (cause) {
    return err(vispError("ARTIFACT_INVALID", `Unreadable ${RECORD}: ${message(cause)}`));
  }
}

async function saveTestsRecord(
  workspace: WorkspaceState,
  feature: string,
  record: IndependentTestsRecord,
  before: IndependentTestsRecord | undefined,
) {
  return applyFileTransaction(workspace.paths.root, "record-acceptance-tests", [
    {
      kind: "write",
      path: workspace.paths.featureFile(feature, RECORD),
      content: `${JSON.stringify(record, null, 2)}\n`,
      ...(before === undefined ? { expectedBefore: { existed: false } } : {}),
    },
  ]);
}

async function waitForRecord(
  workspace: WorkspaceState,
  feature: string,
  waitMs: number,
  record: IndependentTestsRecord,
): Promise<IndependentTestsRecord> {
  const deadline = Date.now() + waitMs;
  let current = record;
  while (current.status === "running" && Date.now() < deadline) {
    await sleep(1000);
    const read = await readTestsRecord(workspace, feature);
    if (read.ok && read.value) current = read.value;
  }
  return current;
}

/** What `done` reports about the pinned tests before the last slice runs them as checks. */
export interface AcceptanceProgress {
  readonly passing: boolean;
  readonly command: string;
  /** Tail of the failing run; `output` would be dropped from compact text. */
  readonly failure?: string;
  readonly note: string;
}

/**
 * Weak workers stopped before the last slice, where pinned tests become checks, so they
 * never saw them fail. Earlier `done` calls run them for information: a failure there
 * does not block closing the slice, since later slices may still owe the behavior.
 */
export async function acceptanceProgress(
  workspace: WorkspaceState,
  feature: string,
  executedChecks: readonly string[],
): Promise<AcceptanceProgress[]> {
  if (executedChecks.some((check) => check.startsWith("PINNED_"))) return [];
  const loaded = await readProductRecord(workspace, { feature });
  if (!loaded.ok) return [];
  const results: AcceptanceProgress[] = [];
  for (const pinned of loaded.value.brief.acceptanceBaseline) {
    const command =
      typeof pinned.command === "string" ? pinned.command.split(" ") : [...pinned.command];
    const outcome = await runBaseline(workspace.paths.root, command);
    const passing = outcome.exitCode === 0 && !outcome.timedOut;
    results.push({
      passing,
      command: command.join(" "),
      ...(passing ? {} : { failure: outcome.output.slice(-1200) }),
      note: passing
        ? "Pinned acceptance tests pass."
        : "Pinned acceptance tests still fail. This does not block this slice, but the last slice cannot close until they pass. Fix the product, not the tests; but never change documented existing behavior to satisfy one. If a test contradicts the request or that documentation, keep the product and record the disagreement with an intent change.",
    });
  }
  return results;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStale(record: IndependentTestsRecord): boolean {
  if (record.pid !== undefined && !processAlive(record.pid)) return true;
  return Date.now() - Date.parse(record.startedAt) > STALE_RUNNING_MS;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

function message(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 1200);
}
