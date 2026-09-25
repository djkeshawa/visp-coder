import { mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { hashValue } from "../core/hash.js";
import { object } from "./adapters.js";
import {
  captureSnapshot,
  EventJournal,
  immutableJson,
  snapshotSchema,
  verifyJournal,
  verifySnapshot,
} from "./artifacts.js";
import { reserveStudyBudget, studyBudgetRequest, verifyStudyReservation } from "./budgets.js";
import { type RunnerResult, type RunnerSpec, runnerSpecSchema } from "./contracts.js";
import { executeFeedbackLoop } from "./feedback-loop.js";
import { runHostTurn } from "./host-turn.js";
import { git } from "./process.js";
import {
  manifestFor,
  prepareRoot,
  type RunManifest,
  resumeIdentity,
  verifyHarness,
} from "./run-support.js";

export interface RunnerOptions {
  readonly outputRoot: string;
  readonly signal?: AbortSignal;
  readonly resumeFrom?: string;
}

/** Runs one explicitly budgeted attempt. Completion is never independent acceptance. */
export async function runExperiment(
  input: RunnerSpec,
  options: RunnerOptions,
): Promise<RunnerResult> {
  const spec = runnerSpecSchema.parse(input);
  const root = await prepareRoot(spec, options.outputRoot);
  const directory = join(root, spec.id);
  const previous = options.resumeFrom ? await inspectRun(options.resumeFrom) : undefined;
  const worktree = previous?.manifest.worktree ?? join(directory, "worktree");
  if (previous) await validateResume(spec, previous, root);
  await mkdir(directory, { mode: 0o700 });
  const lockPath = join(dirname(worktree), "active.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => {
    throw new Error("Run has an active or ambiguous owner; inspect active.lock before retrying");
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, runId: spec.id }));
    const budgetReservation = await reserveStudyBudget(root, studyBudgetRequest(spec));
    if (!previous)
      await git(spec.repository, ["worktree", "add", "--detach", worktree, spec.revision]);
    if (previous) {
      const current = await captureSnapshot(worktree, directory, spec.revision);
      if (hashValue(current) !== previous.result.snapshotHash)
        throw new Error("Resume source changed after the prior attempt");
    }
    await verifyHarness(spec, worktree);
    const initial = await captureSnapshot(worktree, directory, spec.revision);
    immutableJson(join(directory, "initial-snapshot.json"), initial);
    const manifest = manifestFor(
      spec,
      worktree,
      options.resumeFrom ?? null,
      hashValue(initial),
      budgetReservation,
    );
    const manifestHash = hashValue(manifest);
    immutableJson(join(directory, "manifest.json"), { manifest, hash: manifestHash });
    await mkdir(join(directory, "events"), { mode: 0o700 });
    return await performRun(
      manifest,
      directory,
      manifestHash,
      previous?.result.sessionId ?? undefined,
      options.signal,
    );
  } catch (cause) {
    immutableJson(join(directory, "failure.json"), {
      schemaVersion: 1,
      runId: spec.id,
      at: new Date().toISOString(),
      message: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

async function validateResume(
  spec: RunnerSpec,
  previous: Awaited<ReturnType<typeof inspectRun>>,
  root: string,
): Promise<void> {
  if (resumeIdentity(previous.manifest.spec) !== resumeIdentity(spec))
    throw new Error(
      "Resume must preserve the task, host, repository, permissions, and evaluation assignment",
    );
  if (!previous.result.sessionId)
    throw new Error("Resume requires an explicitly recorded host session");
  const worktree = previous.manifest.worktree;
  if (
    basename(worktree) !== "worktree" ||
    dirname(dirname(worktree)) !== root ||
    (await realpath(worktree)) !== worktree
  )
    throw new Error("Resume worktree must remain inside its original runner output root");
}

async function performRun(
  manifest: RunManifest,
  directory: string,
  manifestHash: string,
  resumedSession: string | undefined,
  signal?: AbortSignal,
): Promise<RunnerResult> {
  const { spec, worktree } = manifest;
  const journal = new EventJournal(join(directory, "events"), spec.id, manifestHash);
  const options = { worktree, directory, journal, sessionId: resumedSession, signal };
  const turn = spec.feedbackLoop
    ? await executeFeedbackLoop(spec, options)
    : await runHostTurn(spec, { ...options, prompt: spec.prompt });
  const { diagnostics, usage, estimatedUsd } = turn;
  const feedbackLoop = turn.feedbackLoop;
  await verifyHarness(spec, worktree).catch((cause: Error) => diagnostics.push(cause.message));
  const snapshot = await captureSnapshot(worktree, directory, spec.revision);
  if (
    feedbackLoop?.decision === "pass" &&
    feedbackLoop.review?.subjectDigest !== hashValue(snapshot)
  )
    diagnostics.push("Final candidate differs from the version that passed review");
  if (
    spec.permissions.mode === "read-only" &&
    hashValue(snapshot) !== manifest.initialSnapshotHash
  ) {
    diagnostics.push("Host changed source during a read-only attempt");
  }
  immutableJson(join(directory, "snapshot.json"), snapshot);
  await writeFile(join(directory, "stderr.log"), turn.stderr, { flag: "wx", mode: 0o600 });
  const status = turn.status === "completed" && diagnostics.length ? "failed" : turn.status;
  journal.append({
    type: "runner.finished",
    status,
    estimatedUsd,
    snapshotHash: hashValue(snapshot),
    diagnostics,
    ...(feedbackLoop ? { feedbackLoop } : {}),
  });
  const result: RunnerResult = {
    schemaVersion: 1,
    runId: spec.id,
    manifestHash,
    status,
    exitCode: turn.exitCode,
    sessionId: turn.sessionId,
    startedAt: manifest.startedAt,
    endedAt: new Date().toISOString(),
    eventCount: journal.count,
    eventHead: journal.head,
    snapshotHash: hashValue(snapshot),
    usage,
    estimatedUsd,
    actualBilledUsd: null,
    diagnostics,
    provenance: "local-runner",
    ...(feedbackLoop ? { feedbackLoop } : {}),
  };
  immutableJson(join(directory, "result.json"), { result, hash: hashValue(result) });
  return result;
}

const resultMinimumSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    manifestHash: z.string(),
    status: z.enum(["completed", "failed", "cancelled", "timed-out", "budget-exceeded"]),
    sessionId: z.string().nullable(),
    eventCount: z.number().int().nonnegative(),
    eventHead: z.string(),
    snapshotHash: z.string(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
  })
  .passthrough();

export async function inspectRun(directory: string) {
  const manifestEnvelope = object(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
    "manifest envelope",
  );
  const manifest = object(manifestEnvelope.manifest, "manifest") as unknown as RunManifest;
  runnerSpecSchema.parse(manifest.spec);
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.worktree !== "string" ||
    manifestEnvelope.hash !== hashValue(manifest)
  )
    throw new Error("Manifest integrity verification failed");
  await verifyStudyReservation(dirname(directory), manifest.spec, manifest.budgetReservation);
  const envelope = object(
    JSON.parse(await readFile(join(directory, "result.json"), "utf8")),
    "result envelope",
  );
  const result = resultMinimumSchema.parse(envelope.result) as unknown as RunnerResult;
  if (
    result.runId !== manifest.spec.id ||
    result.manifestHash !== manifestEnvelope.hash ||
    envelope.hash !== hashValue(result) ||
    Date.parse(result.endedAt) < Date.parse(result.startedAt)
  )
    throw new Error("Result integrity verification failed");
  const finalEvent = await verifyJournal(
    join(directory, "events"),
    result.runId,
    result.manifestHash,
    result.eventCount,
    result.eventHead,
  );
  const final = object(finalEvent?.payload, "final runner event");
  if (
    final.type !== "runner.finished" ||
    final.status !== result.status ||
    final.snapshotHash !== result.snapshotHash ||
    final.estimatedUsd !== result.estimatedUsd ||
    hashValue(final.diagnostics) !== hashValue(result.diagnostics) ||
    hashValue(final.feedbackLoop ?? null) !== hashValue(result.feedbackLoop ?? null)
  ) {
    throw new Error("Result disagrees with its final event");
  }
  const initial = snapshotSchema.parse(
    JSON.parse(await readFile(join(directory, "initial-snapshot.json"), "utf8")),
  );
  if (hashValue(initial) !== manifest.initialSnapshotHash)
    throw new Error("Initial source integrity verification failed");
  await verifySnapshot(directory, initial);
  const snapshot = snapshotSchema.parse(
    JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8")),
  );
  if (hashValue(snapshot) !== result.snapshotHash)
    throw new Error("Snapshot integrity verification failed");
  await verifySnapshot(directory, snapshot);
  return { manifest, result, snapshot };
}
