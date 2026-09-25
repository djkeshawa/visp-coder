import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { vispError } from "../../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
  withStateMutation,
} from "../../core/file-transaction.js";
import type { ProjectFileSystem } from "../../core/fs.js";
import { hashValue } from "../../core/hash.js";
import type { ProjectPaths } from "../../core/paths.js";
import { err, ok, type Result } from "../../core/result.js";
import type { Review, Verification } from "./evidence.js";

export interface EvidenceWriteOptions {
  readonly updateCurrent?: boolean;
  /** hashValue of the scoped current record read before execution; null means absent. */
  readonly expectedCurrentHash?: string | null;
}

type Evidence = Verification | Review;

/** History and the applicable projection form one recoverable transaction. */
export function writeEvidenceAttempt(
  paths: ProjectPaths,
  files: ProjectFileSystem,
  name: string,
  record: Evidence,
  schema: z.ZodType<Evidence, z.ZodTypeDef, unknown>,
  options: EvidenceWriteOptions,
): Promise<Result<void>> {
  return withStateMutation(paths.root, async () => {
    const validated = schema.safeParse(record);
    if (!validated.success) return err(vispError("ARTIFACT_INVALID", `Invalid ${name} attempt`));
    const currentPath = paths.evidenceFile(record.feature, record.task, name);
    const before =
      options.updateCurrent === false ? ok(undefined) : await files.readBytesIfExists(currentPath);
    if (!before.ok) return before;
    const current = parseCurrent(before.value, schema, name);
    if (!current.ok) return current;
    const conflict =
      options.updateCurrent === false
        ? undefined
        : projectionConflict(record, current.value, options);
    const mutations: FileMutation[] = [
      {
        kind: "write",
        path: paths.evidenceAttemptFile(record.feature, record.task, name, nextAttemptId()),
        content: json(record),
        expectedBefore: { existed: false },
      },
    ];
    if (options.updateCurrent !== false && !conflict) {
      mutations.push({
        kind: "write",
        path: currentPath,
        content: json(record),
        expectedBefore: filePrecondition(before.value),
      });
    }
    const written = await applyFileTransaction(paths.root, `record-${name}-attempt`, mutations);
    if (!written.ok) return written;
    return persistenceOutcome(conflict, record);
  });
}

function persistenceOutcome(conflict: string | undefined, record: Evidence): Result<void> {
  if (!conflict) return ok(undefined);
  return err(
    vispError("STAGE_BLOCKED", conflict, {
      recovery: "Inspect the newer evidence and rerun validation against the current task inputs.",
      details: {
        historySaved: true,
        projectionUpdated: false,
        feature: record.feature,
        task: record.task,
      },
    }),
  );
}

function parseCurrent(
  bytes: Uint8Array | undefined,
  schema: z.ZodType<Evidence, z.ZodTypeDef, unknown>,
  name: string,
): Result<Evidence | undefined> {
  if (!bytes) return ok(undefined);
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    return parsed.success
      ? ok(parsed.data)
      : err(vispError("ARTIFACT_INVALID", `Invalid current ${name}`));
  } catch {
    return err(vispError("ARTIFACT_INVALID", `Invalid current ${name} JSON`));
  }
}

function projectionConflict(
  record: Evidence,
  current: Evidence | undefined,
  options: EvidenceWriteOptions,
): string | undefined {
  if (
    options.expectedCurrentHash !== undefined &&
    options.expectedCurrentHash !== (current ? hashValue(current) : null)
  ) {
    return "Evidence changed while this attempt was executing; its immutable receipt was retained";
  }
  if (!current) return undefined;
  if (
    record.attempt !== undefined &&
    current.attempt !== undefined &&
    record.attempt <= current.attempt
  ) {
    return "A newer or equal numbered evidence attempt is already current; the older receipt was retained";
  }
  if (Date.parse(record.createdAt) < Date.parse(current.createdAt))
    return "A newer evidence result is already current; the older receipt was retained";
  return undefined;
}

function json(record: Evidence): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

let attemptSequence = 0;
function nextAttemptId(): string {
  attemptSequence = (attemptSequence + 1) % 1_000_000;
  return `${String(Date.now()).padStart(13, "0")}-${String(attemptSequence).padStart(6, "0")}-${randomUUID()}`;
}
