import { randomUUID } from "node:crypto";
import { z } from "zod";
import { vispError } from "../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  inspectFileTransactions,
  withStateMutation,
} from "../core/file-transaction.js";
import { sha256 } from "../core/hash.js";
import { err, ok, type Result } from "../core/result.js";
import { withStateLock } from "../core/state-lock.js";
import { now } from "../workflow/artifacts/common.js";
import type { WorkspaceState } from "../workflow/state.js";
import {
  attemptSchema,
  checkEventSchema,
  type Telemetry,
  telemetrySchema,
  usageReceiptSchema,
} from "./schema.js";

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attempt"), value: attemptSchema }).strict(),
  z.object({ type: z.literal("check"), value: checkEventSchema }).strict(),
  z.object({ type: z.literal("usage"), value: usageReceiptSchema }).strict(),
]);
type TelemetryEvent = z.infer<typeof eventSchema>;
const recordSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive(),
    previousHash: z.string().regex(/^[a-f0-9]{64}$/),
    event: eventSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const EVENT_NAME = /^\d{12}-[a-f0-9-]{36}\.json$/;
const headSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Read-only replay; the legacy JSON remains a compatible, rebuildable projection. */
export async function readTelemetryJournal(state: WorkspaceState): Promise<Result<Telemetry>> {
  return withStateLock(state.paths.root, async () => {
    const transactions = await inspectFileTransactions(state.paths.root);
    if (!transactions.ok) return transactions;
    if (transactions.value.pending.length > 0)
      return err(
        vispError(
          "IO_ERROR",
          "Telemetry has an unfinished file transaction; recover it before reporting",
          {
            recovery: "visp doctor --fix",
          },
        ),
      );
    const journal = await readJournal(state);
    return journal.ok ? ok(journal.value.current) : journal;
  });
}

/** Derive an event from one locked replay; callers never replay just to compute counters. */
export async function mutateTelemetry<T>(
  state: WorkspaceState,
  derive: (current: Telemetry) => Result<{ readonly event?: TelemetryEvent; readonly value: T }>,
): Promise<Result<T>> {
  return withStateMutation(state.paths.root, async () => {
    const journal = await readJournal(state);
    if (!journal.ok) return journal;
    const derived = derive(journal.value.current);
    if (!derived.ok) return derived;
    if (derived.value.event) {
      const written = await appendLocked(state, journal.value, derived.value.event);
      if (!written.ok) return written;
    }
    return ok(derived.value.value);
  });
}

async function appendLocked(
  state: WorkspaceState,
  journal: JournalState,
  event: TelemetryEvent,
): Promise<Result<void>> {
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) return invalid("Invalid telemetry event");
  const sequence = journal.sequence + 1;
  const unsigned = {
    version: 1 as const,
    sequence,
    previousHash: journal.hash,
    event: parsed.data,
  };
  const record = { ...unsigned, hash: sha256(JSON.stringify(unsigned)) };
  const mutations: FileMutation[] = [];
  if (!journal.initialized)
    mutations.push({
      kind: "write",
      path: `${directory(state)}/baseline.json`,
      content: json(journal.current),
      expectedBefore: { existed: false },
    });
  const updated = reduce(journal.current, parsed.data);
  mutations.push(
    {
      kind: "write",
      path: `${directory(state)}/${String(sequence).padStart(12, "0")}-${randomUUID()}.json`,
      content: json(record),
      expectedBefore: { existed: false },
    },
    {
      kind: "write",
      path: `${directory(state)}/head.json`,
      content: json({ version: 1, sequence, hash: record.hash }),
    },
    { kind: "write", path: state.paths.telemetry, content: json(updated) },
  );
  const written = await applyFileTransaction(state.paths.root, "telemetry-event", mutations);
  return written.ok ? ok(undefined) : written;
}

/** Explicit maintenance operation; ordinary reports never repair or rewrite state. */
export async function rebuildTelemetryProjection(state: WorkspaceState): Promise<Result<void>> {
  return withStateMutation(state.paths.root, async () => {
    const journal = await readJournal(state);
    if (!journal.ok) return journal;
    return state.files.writeJson(state.paths.telemetry, journal.value.current);
  });
}

interface JournalState {
  current: Telemetry;
  initialized: boolean;
  sequence: number;
  hash: string;
}

async function readJournal(state: WorkspaceState): Promise<Result<JournalState>> {
  const names = await state.files.listDir(directory(state));
  if (!names.ok) return names;
  const baseline = await state.files.readJsonIfExists(
    `${directory(state)}/baseline.json`,
    parseTelemetry,
  );
  if (!baseline.ok) return baseline;
  if (!baseline.value) {
    if (names.value.length > 0)
      return invalid("Telemetry baseline is missing from an existing journal");
    const legacy = await state.files.readJsonIfExists(state.paths.telemetry, parseTelemetry);
    if (!legacy.ok) return legacy;
    const current = legacy.value ?? {
      kind: "telemetry" as const,
      createdAt: now(),
      attempts: [],
      checks: [],
      usageReceipts: [],
    };
    return ok({ current, initialized: false, sequence: 0, hash: sha256(JSON.stringify(current)) });
  }
  return readExistingJournal(state, names.value, baseline.value);
}

async function readExistingJournal(
  state: WorkspaceState,
  names: string[],
  baseline: Telemetry,
): Promise<Result<JournalState>> {
  let current = baseline;
  let hash = sha256(JSON.stringify(current));
  let sequence = 0;
  for (const name of names
    .filter((name) => name !== "baseline.json" && name !== "head.json")
    .sort()) {
    if (!EVENT_NAME.test(name)) return invalid(`Unexpected telemetry journal entry: ${name}`);
    const record = await state.files.readJson(`${directory(state)}/${name}`, (value) => {
      const parsed = recordSchema.safeParse(value);
      return parsed.success ? ok(parsed.data) : invalid(`Invalid telemetry event: ${name}`);
    });
    if (!record.ok) return record;
    const { hash: recordedHash, ...unsigned } = record.value;
    if (
      unsigned.sequence !== sequence + 1 ||
      unsigned.previousHash !== hash ||
      sha256(JSON.stringify(unsigned)) !== recordedHash
    ) {
      return invalid(`Telemetry journal integrity failed: ${name}`);
    }
    sequence = unsigned.sequence;
    hash = recordedHash;
    current = reduce(current, unsigned.event);
  }
  const head = await state.files.readJson(`${directory(state)}/head.json`, (value) => {
    const parsed = headSchema.safeParse(value);
    return parsed.success ? ok(parsed.data) : invalid("Invalid telemetry journal head");
  });
  if (!head.ok) return head;
  if (head.value.sequence !== sequence || head.value.hash !== hash)
    return invalid("Telemetry journal is incomplete or its head changed");
  return ok({ current, initialized: true, sequence, hash });
}

function reduce(current: Telemetry, event: TelemetryEvent): Telemetry {
  // This projection belongs to the current replay; copying the entire prefix per
  // event makes loading a long journal quadratic before any useful work happens.
  if (event.type === "attempt") current.attempts.push(event.value);
  else if (event.type === "check") current.checks.push(event.value);
  else current.usageReceipts.push(event.value);
  return current;
}

function parseTelemetry(value: unknown): Result<Telemetry> {
  const parsed = telemetrySchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : invalid("Invalid telemetry.json");
}
function directory(state: WorkspaceState): string {
  return `${state.paths.telemetry}.events`;
}
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function invalid(message: string): Result<never> {
  return err(vispError("ARTIFACT_INVALID", message));
}
