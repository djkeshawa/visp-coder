import { vispError } from "../../core/errors.js";
import { applyFileTransaction, filePrecondition } from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { processAlive, processIdentity } from "../../core/process-identity.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import {
  BASELINE_TIMEOUT_MS,
  type IndependentTestsRecord,
  independentTestsRecordSchema,
  message,
  sleep,
  TESTER_TIMEOUT_MS,
} from "./independent-tests-model.js";
import { TESTS_RECORD } from "./pinned-dispute-model.js";

const RECORD = TESTS_RECORD;

const STALE_RUNNING_MS = 2 * TESTER_TIMEOUT_MS + BASELINE_TIMEOUT_MS;

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

export async function saveTestsRecord(
  workspace: WorkspaceState,
  feature: string,
  record: IndependentTestsRecord,
  before: IndependentTestsRecord | undefined,
) {
  const path = workspace.paths.featureFile(feature, RECORD);
  const current = await workspace.files.readTextIfExists(path);
  if (!current.ok) return current;
  if (!before && current.value !== undefined)
    return err(vispError("STATE_BUSY", "Another tester already started for this feature"));
  let parsed: unknown;
  try {
    parsed = current.value === undefined ? null : JSON.parse(current.value);
  } catch {
    return err(vispError("ARTIFACT_INVALID", `Unreadable ${RECORD}`));
  }
  if (before && hashValue(parsed) !== hashValue(before))
    return err(vispError("STATE_BUSY", "The tester record changed while this tester was running"));
  return retryBusy(() =>
    applyFileTransaction(workspace.paths.root, "record-acceptance-tests", [
      {
        kind: "write",
        path,
        content: `${JSON.stringify(record, null, 2)}\n`,
        expectedBefore: filePrecondition(current.value),
      },
    ]),
  );
}

export async function retryBusy<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation();
    if (result.ok || result.error.code !== "STATE_BUSY" || attempt >= 8) return result;
    await sleep(500);
  }
}

export async function waitForRecord(
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

/**
 * A running record is stale once its writer is gone or it outlived every deadline. Codex
 * runs each sandboxed command in its own pid namespace, where another command's tester is
 * invisible (or its pid names an unrelated process): across namespaces liveness cannot be
 * told, so only the age decides.
 */
export async function isStale(record: IndependentTestsRecord): Promise<boolean> {
  if (Date.now() - Date.parse(record.startedAt) > STALE_RUNNING_MS) return true;
  if (record.pid === undefined) return false;
  if (
    record.pidNamespace &&
    (await processIdentity(process.pid)).pidNamespace !== record.pidNamespace
  )
    return false;
  return !processAlive(record.pid);
}
