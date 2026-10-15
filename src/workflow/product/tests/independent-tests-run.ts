import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveCriticPolicy } from "../../../config/critic-defaults.js";
import { vispError } from "../../../core/errors.js";
import { applyFileTransaction } from "../../../core/file-transaction.js";
import { hashValue } from "../../../core/hash.js";
import { processIdentity } from "../../../core/process-identity.js";
import { outputRedactor, redactStrings } from "../../../core/redaction.js";
import { err, ok, type Result } from "../../../core/result.js";
import type { WorkspaceState } from "../../state.js";
import { rulesForRequest, withRules } from "../project-rules.js";
import { type ProductRecord, readProductRecord } from "../store.js";
import { productSourceSnapshot } from "../subject.js";
import { baselineRejection, runBaseline, testCommand } from "./independent-tests-baseline.js";
import {
  executionRefusal,
  launchedOnExistingCode,
  readStartingSource,
  startingSourceDigest,
} from "./independent-tests-mode.js";
import {
  type IndependentTester,
  type IndependentTestsRecord,
  independentTestsRecordSchema,
  message,
  TESTER_OUTPUT_SCHEMA,
  type TesterRequest,
  type TesterResponse,
  type TestFields,
  testerResponseSchema,
} from "./independent-tests-model.js";
import { pinTests, removeFile } from "./independent-tests-pin.js";
import { repairPrompt, testerPrompt } from "./independent-tests-prompts.js";
import {
  isStale,
  readTestsRecord,
  retryBusy,
  saveTestsRecord,
} from "./independent-tests-record.js";
import {
  declineReason,
  invalidFile,
  MAX_FILE_BYTES,
  onlyStructuralChecks,
} from "./independent-tests-validation.js";
import { recordTesterActivity } from "./tester-activity.js";
import { withTesterBrowserKit } from "./tester-browser-kit.js";
import { captureTesterSnapshot, inTesterSnapshot, type TesterSnapshot } from "./tester-snapshot.js";

/** Runs the tester, keeps its file only if it fails on launch-time sources, and pins it. */
export async function writeIndependentTests(
  workspace: WorkspaceState,
  feature: string,
  tester: IndependentTester,
  retryFailed = false,
): Promise<Result<IndependentTestsRecord>> {
  const existing = await readTestsRecord(workspace, feature);
  if (!existing.ok) return existing;
  if (existing.value && !(await mayRestartTester(existing.value, retryFailed)))
    return ok(existing.value);
  if (retryFailed && existing.value?.status === "failed") {
    const pending = await retryPendingPin(workspace, feature, existing.value);
    if (pending) return pending;
  }
  const loaded = await readProductRecord(workspace, { feature });
  if (!loaded.ok) return loaded;
  const setup = await testerSetup(workspace, feature, loaded.value.brief, existing.value);
  if (!setup.ok) return setup;
  const { model, sourceDigest } = setup.value;
  const startedAt = new Date().toISOString();
  if (setup.value.sourceChanged) {
    const declined: IndependentTestsRecord = {
      version: 1,
      status: "declined",
      startedAt,
      finishedAt: startedAt,
      model,
      sourceDigest,
      reason:
        "Product sources changed before the tester started; the before-implementation baseline is inconclusive",
    };
    const saved = await saveTestsRecord(workspace, feature, declined, existing.value);
    return saved.ok ? ok(declined) : saved;
  }
  const { pidNamespace } = await processIdentity(process.pid);
  const running: IndependentTestsRecord = {
    version: 1,
    status: "running",
    startedAt,
    model,
    pid: process.pid,
    ...(pidNamespace ? { pidNamespace } : {}),
    sourceDigest,
  };
  const marked = await saveTestsRecord(workspace, feature, running, existing.value);
  if (!marked.ok) return marked;
  const fields = await testsFromSnapshot(
    workspace,
    feature,
    tester,
    loaded.value.brief,
    setup.value,
  );
  const record = { ...running, ...fields, finishedAt: new Date().toISOString() };
  const saved = await saveTestsRecord(workspace, feature, record, running);
  return saved.ok ? ok(independentTestsRecordSchema.parse(record)) : saved;
}

async function testsFromSnapshot(
  workspace: WorkspaceState,
  feature: string,
  tester: IndependentTester,
  brief: ProductRecord["brief"],
  setup: TesterSetup,
): Promise<TestFields> {
  let snapshot: TesterSnapshot | undefined;
  try {
    const captured = await captureTesterSnapshot(workspace, brief, setup.sourceDigest);
    if (!captured.ok) return { status: "failed", reason: captured.error.message };
    snapshot = captured.value;
    const { existingCodebase } = setup;
    const rules = await rulesForRequest(workspace, feature);
    const request: TesterRequest = {
      root: workspace.paths.root,
      sourceRoot: snapshot.root,
      model: setup.model,
      ...testerEffort(setup.reasoningEffort),
      prompt: testerPrompt(withRules(brief.originalRequest, rules), feature, existingCodebase),
      schema: TESTER_OUTPUT_SCHEMA,
      ...(existingCodebase
        ? { explore: true, blockedPaths: workspace.config.workflow.blockedPaths }
        : {}),
      onActivity: (activity) =>
        recordTesterActivity(workspace, feature, setup.model, existingCodebase, activity),
    };
    return await testOutcome(workspace, feature, tester, request, snapshot, brief.originalRequest);
  } catch (cause) {
    return { status: "failed", reason: message(cause) };
  } finally {
    await snapshot?.dispose();
  }
}

interface TesterSetup {
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly sourceDigest: string;
  readonly sourceChanged: boolean;
  /** The launch-time mode: a retry runs in the mode its first start had. */
  readonly existingCodebase: boolean;
}

/** The launch-time source and mode a run uses, or why VISP refuses to run the tester. */
async function testerSetup(
  workspace: WorkspaceState,
  feature: string,
  brief: ProductRecord["brief"],
  previous: IndependentTestsRecord | undefined,
): Promise<Result<TesterSetup>> {
  const policy = await resolveCriticPolicy(workspace.config.harness, workspace.config.critic);
  if (!policy.ok) return policy;
  const model = policy.value.config?.model;
  if (!model) return err(vispError("CONFIG_INVALID", "The tester needs a configured critic model"));
  const source = await productSourceSnapshot(workspace, brief);
  if (!source.ok) return source;
  const existingCodebase = await launchedOnExistingCode(workspace, feature);
  if (!existingCodebase.ok) return existingCodebase;
  const refused = executionRefusal(workspace, feature, existingCodebase.value);
  if (refused) return err(vispError("CONFIG_INVALID", refused));
  // Starters record the launch source and mode first; a direct `work --write-tests` does here.
  const startedSource = previous
    ? await readStartingSource(workspace, feature)
    : await startingSourceDigest(workspace, feature, brief);
  if (!startedSource.ok) return startedSource;
  const current = hashValue(source.value);
  const sourceDigest = previous?.sourceDigest ?? startedSource.value ?? current;
  return ok({
    model,
    reasoningEffort: policy.value.config?.reasoningEffort,
    sourceDigest,
    sourceChanged: sourceDigest !== current,
    existingCodebase: existingCodebase.value,
  });
}

export async function mayRestartTester(
  record: IndependentTestsRecord,
  retryFailed: boolean,
): Promise<boolean> {
  return (
    (retryFailed && record.status === "failed") ||
    (record.status === "running" && (await isStale(record)))
  );
}

async function testOutcome(
  workspace: WorkspaceState,
  feature: string,
  tester: IndependentTester,
  request: TesterRequest,
  snapshot: TesterSnapshot,
  originalRequest: string,
): Promise<TestFields> {
  const first = await attemptTests(workspace, feature, tester, request, snapshot, originalRequest);
  if (first.status !== "rejected" || !first.content) return first;
  if (
    first.baseline &&
    (first.baseline.spawnFailed || [127, 9009].includes(first.baseline.exitCode))
  )
    return first;
  // Execution feedback: live suites on an existing codebase assumed routes and formats the
  // code does not have. One repair round with the failure output, then the same checks.
  return attemptTests(
    workspace,
    feature,
    tester,
    {
      ...request,
      prompt: repairPrompt(request.prompt, first.content, first.reason ?? ""),
    },
    snapshot,
    originalRequest,
  );
}

async function attemptTests(
  workspace: WorkspaceState,
  feature: string,
  tester: IndependentTester,
  request: TesterRequest,
  snapshot: TesterSnapshot,
  originalRequest: string,
): Promise<TestFields> {
  let response: TesterResponse;
  try {
    response = testerResponseSchema.parse(await tester(request));
  } catch (cause) {
    return { status: "failed", reason: message(cause) };
  }
  const described = {
    tests: response.tests,
    notes: response.notes,
    ambiguities: redactStrings(response.ambiguities, workspace.paths.root),
  };
  if (!response.file)
    return { status: "declined", reason: declineReason(response.notes), ...described };
  // The rejected file stays in the record so a person can see what the tester wrote.
  let content = response.file.content.slice(0, MAX_FILE_BYTES);
  let invalid = invalidFile(response.file);
  if (invalid) return { status: "rejected", reason: invalid, content, ...described };
  const file = await withTesterBrowserKit(originalRequest, response.file);
  content = file.content.slice(0, MAX_FILE_BYTES);
  invalid = invalidFile(file);
  if (invalid) return { status: "rejected", reason: invalid, content, ...described };
  if (onlyStructuralChecks(response))
    return {
      status: "declined",
      reason: "The suite checks only file structure, not a functional outcome",
      ...described,
    };
  const kept = await keepFailingTests(
    workspace,
    feature,
    file,
    response.existingBehavior,
    response.tests.map((test) => test.name),
    snapshot,
  ).catch((cause) => ({ status: "failed" as const, reason: message(cause) }));
  return {
    ...kept,
    ...(["rejected", "failed"].includes(kept.status ?? "") ? { content } : {}),
    ...described,
  };
}

async function retryPendingPin(
  workspace: WorkspaceState,
  feature: string,
  record: IndependentTestsRecord,
): Promise<Result<IndependentTestsRecord> | undefined> {
  if (!record.file || !record.command || !record.content || !record.baseline) return undefined;
  const file = await workspace.files.readTextIfExists(join(workspace.paths.root, record.file));
  if (!file.ok || file.value !== record.content) return undefined;
  const pinned = await pinTests(workspace, feature, record.file, record.command, record.content);
  if (!pinned.ok) return pinned;
  const complete: IndependentTestsRecord = {
    ...record,
    status: "pinned",
    reason: undefined,
    finishedAt: new Date().toISOString(),
  };
  const saved = await saveTestsRecord(workspace, feature, complete, record);
  return saved.ok ? ok(complete) : saved;
}

/** Writes the file, keeps it only if it fails on the unimplemented project, and pins it. */
async function keepFailingTests(
  workspace: WorkspaceState,
  feature: string,
  file: { name: string; content: string },
  existingBehavior: boolean,
  declared: string[],
  snapshot: TesterSnapshot,
): Promise<TestFields> {
  const safeName = file.name.replace(/\.(?:test|spec)\.mjs$/, ".acceptance.mjs");
  const path = `acceptance/${feature}/${safeName}`;
  const command = testCommand(path);
  // Keep redaction anchored to the real project, including values from its env files.
  const redact = await outputRedactor(workspace.paths.root);
  const execute = (extra: Record<string, string> = {}) =>
    inTesterSnapshot(snapshot, async (root) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), file.content, { flag: "wx" });
      return runBaseline(root, command, extra, { redact });
    });
  const { fullOutput, ...stored } = await execute();
  const existing = existingBehavior ? await execute({ VISP_TEST_SCOPE: "existing" }) : undefined;
  const kept = { file: path, command, baseline: stored };
  const rejection = await baselineRejection(
    { ...stored, fullOutput },
    existing,
    declared,
    redact,
    workspace.paths.root,
  );
  if (rejection) return { ...rejection, content: file.content, ...kept };
  // A file with no declared tests skips the name gate, but a failure still needs a FAIL line.
  if (!declared.length && !/^\s*FAIL:/im.test(fullOutput))
    return {
      status: "declined",
      reason:
        "The suite declares no tests and reported no failing test before implementation, so a later failure cannot be attributed to a test or disputed",
      ...kept,
    };
  const written = await retryBusy(() =>
    applyFileTransaction(workspace.paths.root, "write-acceptance-tests", [
      {
        kind: "write",
        path: join(workspace.paths.root, path),
        content: file.content,
        expectedBefore: { existed: false },
      },
    ]),
  );
  if (!written.ok) return { status: "failed", reason: written.error.message };
  const pinned = await pinTests(workspace, feature, path, command, file.content);
  if (pinned.ok) return { status: "pinned", ...kept };
  if (pinned.error.code !== "STATE_BUSY") await removeFile(workspace, path, file.content);
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
