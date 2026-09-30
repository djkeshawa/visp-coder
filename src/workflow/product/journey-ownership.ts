import { z } from "zod";
import { hashValue } from "../../core/hash.js";
import { type BrowserJourney, browserJourneySchema } from "../../testing/browser-journey.js";
import { productJourneyKey } from "../evidence/product-journey.js";
import { isBrowserCheckCommand } from "./check-command.js";
import { outstandingFeedback } from "./findings.js";
import type { ProductRecord } from "./store.js";

/** A declared verifier cannot be bypassed by resolving its captured journey as an experiment. */
export function isDeclaredJourney(
  record: ProductRecord,
  run: {
    id?: string;
    task?: string;
    journeyKey?: string;
    journey?: BrowserJourney;
    journeyDigest?: string;
  },
) {
  return (
    record.state.executions.some(
      (entry) => entry.captureRunId !== undefined && entry.captureRunId === run.id,
    ) || isCurrentDeclaredJourney(record, run)
  );
}

/** Historical ownership survives a method revision; it is not the current assertion. */
function isCurrentDeclaredJourney(
  record: ProductRecord,
  run: { task?: string; journeyKey?: string; journey?: BrowserJourney; journeyDigest?: string },
) {
  return record.brief.checks.some(
    (check) =>
      isBrowserCheckCommand(check.command) &&
      productJourneyKey(check.command.journey, run.task) === ownedJourneyKey(run),
  );
}

/** A revised declared assertion needs execution of that same check, not an ad hoc bypass. */
export function hasExecutedDeclaredRevision(
  record: ProductRecord,
  failure: { id?: string; task?: string; journeyKey?: string },
  replacement: { id?: string; task?: string; journeyKey?: string },
) {
  if (isCurrentDeclaredJourney(record, failure)) return false;
  const owners = record.state.executions.filter(
    (entry) => entry.captureRunId !== undefined && entry.captureRunId === failure.id,
  );
  return (
    owners.length > 0 &&
    owners.every((owner) => {
      const check = record.brief.checks.find((entry) => entry.id === owner.check);
      return (
        check &&
        isBrowserCheckCommand(check.command) &&
        productJourneyKey(check.command.journey, replacement.task) === replacement.journeyKey &&
        record.state.executions.some(
          (entry) =>
            entry.check === owner.check &&
            entry.task === owner.task &&
            entry.status === "passed" &&
            entry.captureRunId !== undefined &&
            entry.captureRunId === replacement.id,
        )
      );
    })
  );
}

export const journeyExpectationSchema = z
  .object({
    basis: z.enum(["agent-proposed", "declared"]),
    outcomes: z.array(z.string().min(1)),
  })
  .strict();

export const journeyRetirementSchema = z
  .object({
    runId: z.string().min(1),
    journeyDigest: z.string().min(1),
    task: z.string().optional(),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/^[^\r\n]+$/, "Use a one-line reason"),
    createdAt: z.string(),
    provenance: z.literal("worker-reported"),
  })
  .strict();

type OwnedJourney = {
  id?: string;
  task?: string;
  journeyKey?: string;
  journey?: BrowserJourney;
  journeyDigest?: string;
  expectation?: z.infer<typeof journeyExpectationSchema>;
  operations?: readonly { id: string; description?: string }[];
  captures?: readonly { id: string; path?: string }[];
};

/** A reviewer can retain a discovered defect by citing its runner evidence. */
export function isReviewerRequiredJourney(record: ProductRecord, run: OwnedJourney) {
  const refs = new Set(
    [
      run.id,
      run.id ? `HIST-${run.id}` : undefined,
      ...(run.operations ?? []).map((entry) => entry.id),
      ...(run.captures ?? []).flatMap((entry) => [entry.id, entry.path]),
      ...record.state.executions
        .filter((entry) => entry.captureRunId === run.id)
        .map((entry) => entry.id),
    ].filter((id): id is string => id !== undefined),
  );
  return outstandingFeedback(record).some(
    (finding) =>
      finding.required &&
      finding.phase === "product" &&
      finding.evidence.some((id) => refs.has(id)),
  );
}

/** Unknown legacy ownership stays obligatory; only explicitly unlinked hypotheses are informational. */
export function isExploratoryJourney(record: ProductRecord, run: OwnedJourney) {
  return journeyOwnershipIndex(record).isExploratory(run);
}

function ownedJourneyKey(run: {
  journeyKey?: string;
  task?: string;
  journey?: BrowserJourney;
  journeyDigest?: string;
}) {
  return run.journey && hashValue(run.journey) === run.journeyDigest
    ? productJourneyKey(run.journey, run.task)
    : run.journeyKey;
}

const ownedJourneySchema = z.object({
  id: z.string().optional(),
  task: z.string().optional(),
  journeyKey: z.string().optional(),
  journey: browserJourneySchema.optional(),
  journeyDigest: z.string().optional(),
  expectation: journeyExpectationSchema.optional(),
  status: z.string().optional(),
  failure: z.object({ kind: z.string() }).optional(),
  operations: z.array(z.object({ id: z.string(), description: z.string().optional() })).optional(),
  captures: z.array(z.object({ id: z.string(), path: z.string().optional() })).optional(),
});

/** Parse and hash each historical journey once per evaluation, then look up retained ownership. */
export function journeyOwnershipIndex(record: ProductRecord) {
  const runs = record.state.captureRuns.flatMap((candidate) => {
    const parsed = ownedJourneySchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
  const requiredRefs = new Set(
    outstandingFeedback(record)
      .filter((finding) => finding.required && finding.phase === "product")
      .flatMap((finding) => finding.evidence),
  );
  const executions = new Set(
    record.state.executions.flatMap((entry) => (entry.captureRunId ? [entry.captureRunId] : [])),
  );
  const executionRefs = new Map<string, string[]>();
  for (const entry of record.state.executions) {
    if (!entry.captureRunId) continue;
    const refs = executionRefs.get(entry.captureRunId) ?? [];
    refs.push(entry.id);
    executionRefs.set(entry.captureRunId, refs);
  }
  const tasks = new Set([
    undefined,
    ...record.brief.slices.map((slice) => slice.id),
    ...runs.map((run) => run.task),
  ]);
  const declared = declaredJourneyKeys(record, tasks);
  const keys = new WeakMap<OwnedJourney, string | undefined>();
  const identity = (run: OwnedJourney) => {
    if (!keys.has(run)) keys.set(run, ownedJourneyKey(run));
    return JSON.stringify([run.task, keys.get(run)]);
  };
  const directlyRetained = (run: OwnedJourney) =>
    executions.has(run.id ?? "") ||
    declared.has(identity(run)) ||
    run.expectation?.basis === "declared" ||
    !!run.expectation?.outcomes.length ||
    run.operations?.some((entry) => entry.description === "Uncaught application exception") ||
    [
      run.id,
      run.id ? `HIST-${run.id}` : undefined,
      ...(run.operations ?? []).map((entry) => entry.id),
      ...(run.captures ?? []).flatMap((entry) => [entry.id, entry.path]),
      ...(executionRefs.get(run.id ?? "") ?? []),
    ].some((id) => !!id && requiredRefs.has(id));
  const retained = new Set<string>();
  for (const run of runs)
    if (
      directlyRetained(run) ||
      (!run.expectation && run.failure?.kind === "behavior" && run.status !== "completed")
    ) {
      const key = identity(run);
      if (keys.get(run)) retained.add(key);
    }
  return {
    isExploratory: (run: OwnedJourney) =>
      run.expectation?.basis === "agent-proposed" &&
      run.expectation.outcomes.length === 0 &&
      !directlyRetained(run) &&
      !retained.has(identity(run)),
  };
}

function declaredJourneyKeys(record: ProductRecord, tasks: ReadonlySet<string | undefined>) {
  const keys = new Set<string>();
  for (const task of tasks)
    for (const check of record.brief.checks)
      if (isBrowserCheckCommand(check.command))
        keys.add(JSON.stringify([task, productJourneyKey(check.command.journey, task)]));
  return keys;
}
