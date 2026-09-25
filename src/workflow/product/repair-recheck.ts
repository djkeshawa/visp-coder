import { recordedReplayRuns, replayCommand } from "../evidence/capture-replay.js";
import { compareObservations } from "./behavior-changes.js";
import { environmentRepairCandidate } from "./environment-repair.js";
import { type FindingReference, selectRepairReproduction } from "./repair-reproduction.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";

const guidance =
  "Replay the reported input and check a nearby affected behavior. Compare actual results; execution is not resolution. Historical IDs are references, not fresh evidence. This is advisory.";

/** Recheck pointers must not crowd implementation code out with duplicated run measurements. */
function observationReference(run: {
  id: string;
  subjectDigest: string;
  status?: string;
  comparisonEnvironment?: string;
  captures?: readonly { id: string }[];
}) {
  return {
    runId: run.id,
    subjectDigest: run.subjectDigest,
    status: run.status,
    ...(run.comparisonEnvironment ? { comparisonEnvironment: run.comparisonEnvironment } : {}),
    captureIds: run.captures?.map((capture) => capture.id) ?? [],
  };
}

function comparisonReference(
  before: Parameters<typeof compareObservations>[1],
  after: Parameters<typeof compareObservations>[1],
) {
  const comparison = compareObservations(before, after);
  return (
    comparison && {
      change: comparison.change,
      sameSubject: comparison.sameSubject,
      before: observationReference(before),
      after: observationReference(after),
    }
  );
}

/** Derive a focused recheck from cited runner evidence; never infer a path from prose. */
export function repairRecheck(
  record: ProductRecord,
  finding: FindingReference,
  subject: string,
  task?: string,
) {
  const runs = recordedReplayRuns(record, task);
  const executions = scopedExecutions(record, task);
  const reproduction = selectRepairReproduction(record, finding, subject, [...runs, ...executions]);
  const citedExecutions = executions.filter(
    (entry) =>
      entry.subjectDigest === reproduction.subjectDigest &&
      reproduction.evidence.includes(entry.id),
  );
  const cited = new Set([
    ...reproduction.evidence,
    ...citedExecutions.flatMap((entry) => (entry.captureRunId ? [entry.captureRunId] : [])),
  ]);
  const original = citedJourney(runs, reproduction.subjectDigest, cited);
  if (original) {
    const current = runs
      .slice(runs.indexOf(original) + 1)
      .findLast(
        (run) =>
          run.id !== original.id &&
          run.subjectDigest === subject &&
          run.journeyDigest === original.journeyDigest,
      );
    const environmentRepair = environmentRepairCandidate(
      record,
      finding,
      original,
      current,
      subject,
    );
    return {
      ...(environmentRepair ? { environmentRepair } : {}),
      advisory: true as const,
      kind: "journey" as const,
      status: current ? ("observed-unassessed" as const) : ("not-reobserved" as const),
      ...(current
        ? { comparison: comparisonReference(original, current) }
        : { before: observationReference(original) }),
      command: replayCommand(record.brief.feature, original.id, task),
      guidance,
    };
  }
  const before = citedExecutions[0];
  if (!before) return undefined;
  const after = executions
    .slice(executions.indexOf(before) + 1)
    .findLast(
      (entry) =>
        entry.id !== before.id &&
        entry.subjectDigest === subject &&
        entry.check === before.check &&
        entry.command === before.command,
    );
  const environmentRepair = environmentRepairCandidate(record, finding, before, after, subject);
  return {
    ...(environmentRepair ? { environmentRepair } : {}),
    advisory: true as const,
    kind: "check" as const,
    check: before.check,
    status: after ? ("observed-unassessed" as const) : ("not-reobserved" as const),
    ...(after
      ? { comparison: comparisonReference(before, after) }
      : { before: observationReference(before) }),
    command: `visp verify --feature ${record.brief.feature}${task ? ` --task ${task}` : ""}`,
    guidance,
  };
}

/** Use citation order, not recency; ambiguous IDs never select a replay target. */
function citedJourney(
  runs: ReturnType<typeof recordedReplayRuns>,
  subject: string,
  cited: Set<string>,
) {
  const originals = runs.filter((run) => run.subjectDigest === subject);
  for (const id of cited) {
    const matches = originals.filter(
      (run) =>
        run.id === id ||
        run.captures.some((entry) => entry.id === id) ||
        run.operations.some((entry) => entry.id === id),
    );
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function scopedExecutions(record: ProductRecord, task?: string) {
  const contract = productContractDigest(
    record.brief,
    record.brief.slices.find((slice) => slice.id === task),
  );
  return record.state.executions.filter(
    (entry) =>
      entry.task === task &&
      entry.contractDigest === contract &&
      record.brief.checks.some((check) => check.id === entry.check),
  );
}
