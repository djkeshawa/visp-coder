import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
  inspectFileTransactions,
  withStateMutation,
} from "../core/file-transaction.js";
import { ProjectFileSystem } from "../core/fs.js";
import { canonicalJson, hashValue } from "../core/hash.js";
import { ok, type Result } from "../core/result.js";
import { withStateLock } from "../core/state-lock.js";
import type { RunnerSpec } from "./contracts.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const microUsd = z.string().regex(/^(0|[1-9]\d{0,319})$/);
const MAX_RESERVATIONS = 10_000;
const approvalFields = {
  study: id,
  studyApprovalId: id,
  studyMaxEstimatedUsd: z.number().finite().positive(),
};
const requestSchema = z
  .object({
    ...approvalFields,
    runId: id,
    runSpecHash: digest,
    maxEstimatedUsd: z.number().finite().positive(),
  })
  .strict()
  .refine(
    (value) => value.maxEstimatedUsd <= value.studyMaxEstimatedUsd,
    "Attempt maximum must not exceed the approved study maximum",
  );
export type StudyBudgetRequest = z.infer<typeof requestSchema>;
const approvalSchema = z.object({ schemaVersion: z.literal(1), ...approvalFields }).strict();
const reservationSchema = z
  .object({
    ...requestSchema.innerType().shape,
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive().max(MAX_RESERVATIONS),
    at: z.string().datetime(),
    allocatedMicroUsd: microUsd,
    cumulativeMicroUsd: microUsd,
    approvalHash: digest,
    previousHash: digest,
    hash: digest,
  })
  .strict();
export type StudyBudgetReservation = z.infer<typeof reservationSchema>;
const projectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    approvalHash: digest,
    count: z.number().int().positive().max(MAX_RESERVATIONS),
    head: digest,
    allocatedMicroUsd: microUsd,
  })
  .strict();

interface Ledger {
  readonly approval: z.infer<typeof approvalSchema>;
  readonly reservations: readonly StudyBudgetReservation[];
  readonly projection: z.infer<typeof projectionSchema>;
  readonly projectionBytes: Uint8Array;
}

export function studyBudgetRequest(spec: RunnerSpec): StudyBudgetRequest {
  return {
    study: spec.assignment.study,
    studyApprovalId: spec.budget.studyApprovalId,
    studyMaxEstimatedUsd: spec.budget.studyMaxEstimatedUsd,
    runId: spec.id,
    runSpecHash: hashValue(spec),
    maxEstimatedUsd: spec.budget.maxEstimatedUsd,
  };
}

/** Reserve the full attempt allocation once. No execution result refunds or reuses it. */
export async function reserveStudyBudget(
  outputRoot: string,
  input: StudyBudgetRequest,
): Promise<StudyBudgetReservation> {
  const request = requestSchema.parse(input);
  const root = await realpath(outputRoot);
  return unwrap(
    await withStateMutation(root, async () => {
      const files = new ProjectFileSystem(root);
      const current = await readLedger(files, request.study);
      const approval = approvalSchema.parse({ schemaVersion: 1, ...approvalOf(request) });
      assertAllocationAvailable(current, request, approval);
      const reservation = makeReservation(current, request, approval);
      const changes = reservationMutations(current, reservation, approval);
      unwrap(await applyFileTransaction(root, "reserve-study-budget", changes));
      return ok(reservation);
    }),
  );
}

/** Check every immutable reservation, run copy, and head before reporting available allocation. */
export async function inspectStudyBudget(outputRoot: string, study: string) {
  id.parse(study);
  const root = await realpath(outputRoot);
  return unwrap(
    await withStateLock(root, async () => {
      const transactions = unwrap(await inspectFileTransactions(root));
      if (transactions.pending.length > 0)
        throw new Error(
          "Study budget has an unfinished file transaction; recover it before reporting allocation",
        );
      const ledger = await readLedger(new ProjectFileSystem(root), study);
      if (!ledger) throw new Error("Missing study budget ledger");
      return ok({
        approval: ledger.approval,
        reservations: ledger.reservations,
        allocatedMicroUsd: ledger.projection.allocatedMicroUsd,
        remainingMicroUsd: (
          units(ledger.approval.studyMaxEstimatedUsd, false) -
          BigInt(ledger.projection.allocatedMicroUsd)
        ).toString(),
      });
    }),
  );
}

export async function verifyStudyReservation(
  outputRoot: string,
  spec: RunnerSpec,
  value: unknown,
): Promise<void> {
  const reservation = reservationSchema.parse(value);
  const ledger = await inspectStudyBudget(outputRoot, spec.assignment.study);
  const recorded = ledger.reservations.find((entry) => entry.runId === spec.id);
  const request = studyBudgetRequest(spec);
  if (
    !recorded ||
    hashValue(recorded) !== hashValue(reservation) ||
    Object.entries(request).some(([key, expected]) => Reflect.get(reservation, key) !== expected)
  )
    throw new Error("Run budget reservation failed integrity verification");
}

function approvalOf(
  value: Pick<StudyBudgetRequest, "study" | "studyApprovalId" | "studyMaxEstimatedUsd">,
) {
  return {
    study: value.study,
    studyApprovalId: value.studyApprovalId,
    studyMaxEstimatedUsd: value.studyMaxEstimatedUsd,
  };
}

function assertAllocationAvailable(
  current: Ledger | undefined,
  request: StudyBudgetRequest,
  approval: z.infer<typeof approvalSchema>,
): void {
  if (current && hashValue(current.approval) !== hashValue(approval))
    throw new Error(
      "Study approval and ceiling are immutable; an explicitly new study is required",
    );
  if (current?.reservations.some((entry) => entry.runId === request.runId))
    throw new Error("This attempt already reserved its study allocation; use a new run identity");
  if ((current?.reservations.length ?? 0) >= MAX_RESERVATIONS)
    throw new Error("Study reservation limit reached; retain this ledger and register a new study");
  const allocated = BigInt(current?.projection.allocatedMicroUsd ?? "0");
  if (allocated + units(request.maxEstimatedUsd, true) > units(request.studyMaxEstimatedUsd, false))
    throw new Error(
      "Study allocation is exhausted; previous attempts retain their full reservations",
    );
}

function makeReservation(
  current: Ledger | undefined,
  request: StudyBudgetRequest,
  approval: z.infer<typeof approvalSchema>,
): StudyBudgetReservation {
  const allocated = units(request.maxEstimatedUsd, true);
  const approvalHash = hashValue(approval);
  const record = {
    ...request,
    schemaVersion: 1 as const,
    sequence: (current?.projection.count ?? 0) + 1,
    at: new Date().toISOString(),
    allocatedMicroUsd: allocated.toString(),
    cumulativeMicroUsd: (
      BigInt(current?.projection.allocatedMicroUsd ?? "0") + allocated
    ).toString(),
    approvalHash,
    previousHash: current?.projection.head ?? approvalHash,
  };
  return { ...record, hash: hashValue(record) };
}

function reservationMutations(
  current: Ledger | undefined,
  record: StudyBudgetReservation,
  approval: z.infer<typeof approvalSchema>,
): FileMutation[] {
  const directory = studyDirectory(record.study);
  const immutable = (path: string, value: unknown): FileMutation => ({
    kind: "write",
    path,
    content: `${canonicalJson(value)}\n`,
    mode: 0o600,
    expectedBefore: { existed: false },
  });
  return [
    ...(current ? [] : [immutable(join(directory, "approval.json"), approval)]),
    immutable(join(directory, "reservations", reservationName(record.sequence)), record),
    immutable(join(record.runId, "budget-reservation.json"), record),
    {
      kind: "write",
      path: join(directory, "projection.json"),
      content: `${canonicalJson({
        schemaVersion: 1,
        approvalHash: record.approvalHash,
        count: record.sequence,
        head: record.hash,
        allocatedMicroUsd: record.cumulativeMicroUsd,
      })}\n`,
      mode: 0o600,
      expectedBefore: filePrecondition(current?.projectionBytes),
    },
  ];
}

async function readLedger(files: ProjectFileSystem, study: string): Promise<Ledger | undefined> {
  const directory = studyDirectory(study);
  const approvalBytes = unwrap(await files.readBytesIfExists(join(directory, "approval.json")));
  const projectionBytes = unwrap(await files.readBytesIfExists(join(directory, "projection.json")));
  const names = unwrap(await files.listDir(join(directory, "reservations")));
  if (!approvalBytes && !projectionBytes && !names.length) {
    await assertNoMissingLedger(files, study);
    return undefined;
  }
  if (!approvalBytes || !projectionBytes)
    throw new Error("Study budget evidence is missing or incomplete");
  const approval = decode(approvalBytes, approvalSchema);
  const projection = decode(projectionBytes, projectionSchema);
  if (approval.study !== study || projection.approvalHash !== hashValue(approval))
    throw new Error("Study budget approval integrity verification failed");
  if (names.length !== projection.count)
    throw new Error("Study budget reservation evidence is missing or incomplete");
  const reservations = await readReservations(files, approval, names);
  const last = reservations.at(-1);
  if (
    last?.hash !== projection.head ||
    last.cumulativeMicroUsd !== projection.allocatedMicroUsd ||
    BigInt(projection.allocatedMicroUsd) > units(approval.studyMaxEstimatedUsd, false)
  )
    throw new Error("Study budget projection integrity verification failed");
  return { approval, reservations, projection, projectionBytes };
}

async function readReservations(
  files: ProjectFileSystem,
  approval: z.infer<typeof approvalSchema>,
  names: readonly string[],
): Promise<StudyBudgetReservation[]> {
  const reservations: StudyBudgetReservation[] = [];
  const approvalHash = hashValue(approval);
  let previousHash = approvalHash;
  let cumulative = 0n;
  const runs = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (name !== reservationName(index + 1))
      throw new Error("Study reservation sequence is incomplete");
    const bytes = unwrap(
      await files.readBytes(join(studyDirectory(approval.study), "reservations", name)),
    );
    const record = decode(bytes, reservationSchema);
    const { hash, ...body } = record;
    cumulative += units(record.maxEstimatedUsd, true);
    if (
      hashValue(body) !== hash ||
      record.previousHash !== previousHash ||
      record.approvalHash !== approvalHash ||
      record.sequence !== index + 1 ||
      hashValue(approvalOf(record)) !== hashValue(approvalOf(approval)) ||
      record.allocatedMicroUsd !== units(record.maxEstimatedUsd, true).toString() ||
      record.cumulativeMicroUsd !== cumulative.toString() ||
      runs.has(record.runId)
    )
      throw new Error("Study reservation integrity verification failed");
    const copy = unwrap(await files.readBytes(join(record.runId, "budget-reservation.json")));
    if (hashValue(decode(copy, reservationSchema)) !== hashValue(record))
      throw new Error("Run budget reservation integrity verification failed");
    runs.add(record.runId);
    reservations.push(record);
    previousHash = hash;
  }
  return reservations;
}

async function assertNoMissingLedger(files: ProjectFileSystem, study: string): Promise<void> {
  for (const entry of unwrap(await files.listEntries(files.root))) {
    if (entry.type !== "directory" || !id.safeParse(entry.name).success) continue;
    const copy = unwrap(await files.readBytesIfExists(join(entry.name, "budget-reservation.json")));
    if (copy && decode(copy, reservationSchema).study === study)
      throw new Error("Missing study budget ledger for an existing attempt reservation");
  }
}

/** Exact decimal arithmetic, rounded up for attempts and down for approved ceilings. */
function units(usd: number, roundUp: boolean): bigint {
  const [coefficient = "0", exponent = "0"] = usd.toString().split("e");
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const digits = BigInt(whole + fraction);
  const scale = 6 + Number(exponent) - fraction.length;
  if (scale >= 0) return digits * 10n ** BigInt(scale);
  const divisor = 10n ** BigInt(-scale);
  return (digits + (roundUp ? divisor - 1n : 0n)) / divisor;
}

function studyDirectory(study: string): string {
  return join(".visp-runner", "studies", study);
}
function reservationName(sequence: number): string {
  return `${String(sequence).padStart(8, "0")}.json`;
}
function decode<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  if (bytes.length > 32 * 1024) throw new Error("Study budget evidence exceeds its size limit");
  try {
    return schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch {
    throw new Error("Study budget evidence is malformed; inspect the retained ledger");
  }
}
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
