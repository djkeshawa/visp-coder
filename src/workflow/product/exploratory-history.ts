import { historicalFailureIdentity } from "../evidence/journey-history.js";
import { productCaptureRunSchema } from "./evidence-references.js";
import { journeyOwnershipIndex } from "./journey-ownership.js";
import type { ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";

const MAX_JOURNEYS = 6;
const MAX_REFERENCE_LENGTH = 160;

/** Only intact, uniquely identified runner failures can supply historical negative evidence. */
export function exploratoryFailureHistory(record: ProductRecord, slice?: ProductSlice) {
  const ids = captureRunIdCounts(record.state.captureRuns);
  const representatives = new Map<string, ReturnType<typeof productCaptureRunSchema.parse>>();
  let total = 0;
  for (const candidate of record.state.captureRuns) {
    const parsed = productCaptureRunSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const run = parsed.data;
    if (
      run.expectation?.basis !== "agent-proposed" ||
      run.expectation.outcomes.length ||
      run.failure?.kind !== "behavior" ||
      run.status === "completed" ||
      (slice && run.task && run.task !== slice.id)
    )
      continue;
    total += 1;
    if (
      !run.id ||
      run.id.length > MAX_REFERENCE_LENGTH ||
      ids.get(run.id) !== 1 ||
      (run.task && !record.brief.slices.some((entry) => entry.id === run.task))
    )
      continue;
    const key = historicalFailureIdentity(run);
    if (!key) continue;
    representatives.delete(key);
    representatives.set(key, run);
  }
  const runs = [...representatives.values()].slice(-MAX_JOURNEYS);
  return { runs, omitted: total - runs.length };
}

/** Original failed observations stay stale; these references can only retain a required finding. */
export function historicalFailureReferences(run: ReturnType<typeof productCaptureRunSchema.parse>) {
  return [
    `HIST-${run.id}`,
    ...run.operations
      .filter((entry) => {
        if (entry.id.length > MAX_REFERENCE_LENGTH) return false;
        if (entry.id === run.failure?.operationId) return true;
        if (!entry.measurement || entry.measurement.truncated) return false;
        try {
          return JSON.parse(entry.measurement.json).matched === false;
        } catch {
          return false;
        }
      })
      .slice(-2)
      .map((entry) => entry.id),
  ];
}

export function exploratoryReviewHistory(record: ProductRecord, slice?: ProductSlice) {
  const history = exploratoryFailureHistory(record, slice);
  const ownership = journeyOwnershipIndex(record);
  const retirementByRun = new Map(
    (record.state.journeyRetirements ?? []).map((entry) => [
      JSON.stringify([entry.runId, entry.journeyDigest]),
      entry,
    ]),
  );
  const retirementSummary = (
    entry: NonNullable<ProductRecord["state"]["journeyRetirements"]>[number],
  ) => ({
    runId: entry.runId,
    journeyDigest: entry.journeyDigest,
    task: entry.task,
    reason: entry.reason.slice(0, 240),
    reasonCharactersOmitted: Math.max(0, entry.reason.length - 240),
    provenance: "worker-reported" as const,
    createdAt: entry.createdAt.slice(0, 80),
  });
  const retirements = (record.state.journeyRetirements ?? []).filter(
    (entry) =>
      (!slice || !entry.task || entry.task === slice.id) &&
      entry.runId.length <= MAX_REFERENCE_LENGTH &&
      entry.journeyDigest.length <= MAX_REFERENCE_LENGTH,
  );
  const latestRetirements = new Map(
    retirements.map((entry) => [JSON.stringify([entry.task, entry.journeyDigest]), entry]),
  );
  const shownRetirements = [...latestRetirements.values()].slice(-MAX_JOURNEYS);
  return {
    exploratory: history.runs.map((run) => {
      const retirement = retirementByRun.get(JSON.stringify([run.id, run.journeyDigest]));
      return {
        runId: run.id,
        status: run.status,
        message: run.failure?.message.slice(0, 600),
        messageCharactersOmitted: Math.max(0, (run.failure?.message.length ?? 0) - 600),
        informational: ownership.isExploratory(run),
        retirement: retirement ? retirementSummary(retirement) : undefined,
        evidence: historicalFailureReferences(run),
        evidenceOmitted: Math.max(
          0,
          run.operations.length +
            run.captures.length -
            (historicalFailureReferences(run).length - 1),
        ),
        evidenceUse:
          "Historical negative evidence: cite only in a required product finding to require repair/replay; never current passing evidence or acceptance credit.",
      };
    }),
    exploratoryOmitted: history.omitted,
    retirements: shownRetirements.map(retirementSummary),
    retirementsOmitted: retirements.length - shownRetirements.length,
    originalRecords: `.visp/features/${record.brief.feature}/product-state.json: captureRuns and journeyRetirements retain every original record; use runId with visp capture --replay to inspect the original journey.`,
  };
}

function captureRunIdCounts(runs: readonly unknown[]) {
  const ids = new Map<string, number>();
  for (const candidate of runs)
    if (
      candidate &&
      typeof candidate === "object" &&
      "id" in candidate &&
      typeof candidate.id === "string"
    )
      ids.set(candidate.id, (ids.get(candidate.id) ?? 0) + 1);
  return ids;
}

/** Persisted historical citations keep their original runner subject when deriving repair pointers. */
export function historicalFindingJourney(record: ProductRecord, evidence: readonly string[]) {
  const ids = captureRunIdCounts(record.state.captureRuns);
  for (const reference of evidence) {
    if (!reference.startsWith("HIST-")) continue;
    const id = reference.slice(5);
    if (ids.get(id) !== 1) continue;
    for (const candidate of record.state.captureRuns) {
      const run = productCaptureRunSchema.safeParse(candidate);
      if (
        run.success &&
        run.data.id === id &&
        run.data.failure?.kind === "behavior" &&
        run.data.status !== "completed" &&
        historicalFailureIdentity(run.data)
      )
        return run.data;
    }
  }
  return undefined;
}
