import { hashValue } from "../../core/hash.js";
import { productJourneyKey } from "../evidence/product-journey.js";
import {
  describeProductCheck,
  isBrowserCheckCommand,
  productCheckSupportsBehavior,
} from "./check-command.js";
import { type RepairEnvironmentChange, repairEnvironments } from "./comparison-environment.js";
import {
  evidenceApplies,
  latestCurrentJourneys,
  productCaptureRunSchema,
} from "./evidence-references.js";
import type { ProductExecution } from "./model.js";
import { findingReproductions } from "./reproduction-bindings.js";
import type { ProductRecord } from "./store.js";

export interface FunctionalFinding {
  readonly id?: string;
  readonly legacyId?: string;
  readonly task?: string;
  readonly subjectDigest: string;
  readonly evidence: readonly string[];
}

/** Disproof is a separate assessment of fresh execution, never a fabricated repair pair. */
export function functionalDisproofEvidenceGap(
  record: ProductRecord,
  finding: FunctionalFinding,
  counterevidence: readonly string[],
): string | undefined {
  return witnessedFunctionalExecutions(record, finding, counterevidence).length
    ? undefined
    : "Disproving a functional finding requires fresh successful executed counterevidence with identified verifier inputs";
}

export function witnessedFunctionalExecutions(
  record: ProductRecord,
  finding: FunctionalFinding,
  counterevidence: readonly string[],
) {
  const unique = uniqueIds(record.state.executions);
  const latestComparable = latestComparableExecutions(record.state.executions);
  return record.state.executions.filter(
    (entry) =>
      counterevidence.includes(entry.id) &&
      unique(entry.id) &&
      latestComparable.get(comparableExecutionKey(entry)) === entry &&
      (!finding.task || entry.task === finding.task) &&
      entry.status === "passed" &&
      entry.exitCode === 0 &&
      entry.provenance === "supervisor-executed" &&
      !!entry.contractDigest &&
      evidenceApplies(record, entry.subjectDigest, entry) &&
      identifiedCounterexample(record, entry) &&
      (!entry.captureRunId ||
        latestCurrentJourneys(record, entry.subjectDigest, entry.task).some(
          (run) => run.id === entry.captureRunId,
        )),
  );
}

/** Current failed receipts may be attached; relevance still requires later assessment. */
export function witnessedFunctionalFailure(
  record: ProductRecord,
  finding: FunctionalFinding,
  id: string,
  subject: string,
) {
  const matches = record.state.executions.filter((entry) => entry.id === id);
  const entry = matches[0];
  return matches.length === 1 &&
    entry &&
    entry.task === finding.task &&
    entry.subjectDigest === subject &&
    entry.status === "failed" &&
    entry.exitCode !== 0 &&
    entry.provenance === "supervisor-executed" &&
    entry.comparisonEnvironment?.trim() &&
    evidenceApplies(record, subject, entry) &&
    identifiedCounterexample(record, entry)
    ? entry
    : undefined;
}

function identifiedCounterexample(record: ProductRecord, entry: ProductExecution) {
  const check = record.brief.checks.find((check) => check.id === entry.check);
  if (
    !check ||
    !productCheckSupportsBehavior(check) ||
    describeProductCheck(check) !== entry.command
  )
    return false;
  if (!isBrowserCheckCommand(check.command)) return !entry.captureRunId && !!entry.verifierDigest;
  const matching = record.state.captureRuns.flatMap((input) => {
    const parsed = productCaptureRunSchema.safeParse(input);
    return parsed.success && parsed.data.id === entry.captureRunId ? [parsed.data] : [];
  });
  if (matching.length !== 1) return false;
  const run = matching[0];
  return (
    !!run &&
    (entry.status === "failed"
      ? run.status !== "completed" && run.failure?.kind === "behavior"
      : run.status === "completed") &&
    run.subjectDigest === entry.subjectDigest &&
    run.contractDigest === entry.contractDigest &&
    run.task === entry.task &&
    !!run.journey &&
    hashValue(run.journey) === run.journeyDigest &&
    productJourneyKey(run.journey, run.task) === run.journeyKey &&
    run.journeyKey === productJourneyKey(check.command.journey, entry.task)
  );
}

export interface FunctionalRepairWitness {
  readonly subjectDigest: string;
  readonly input: string;
  readonly reproductionId: string;
  readonly recheckId: string;
}

/** Return the exact witnessed pair, not merely a fresh citation in the same review. */
export function findFunctionalRepair(
  record: ProductRecord,
  finding: FunctionalFinding,
  counterevidence: readonly string[],
  environmentChange?: RepairEnvironmentChange,
): FunctionalRepairWitness | undefined {
  const candidates = [
    finding,
    ...findingReproductions(record, finding).map((link) => ({
      task: link.task,
      subjectDigest: link.subjectDigest,
      evidence: [link.execution],
    })),
  ];
  for (const candidate of candidates) {
    const witness = findWitnessedRepair(record, candidate, counterevidence, environmentChange);
    if (witness) return witness;
  }
  return undefined;
}

function findWitnessedRepair(
  record: ProductRecord,
  finding: FunctionalFinding,
  counterevidence: readonly string[],
  environmentChange?: RepairEnvironmentChange,
): FunctionalRepairWitness | undefined {
  const executions = record.state.executions;
  const unique = uniqueIds(executions);
  const latestComparable = latestComparableExecutions(executions);
  for (const [index, before] of executions.entries()) {
    if (
      !finding.evidence.includes(before.id) ||
      (finding.task !== undefined && before.task !== finding.task) ||
      before.subjectDigest !== finding.subjectDigest ||
      before.status !== "failed" ||
      before.exitCode === 0 ||
      before.provenance !== "supervisor-executed" ||
      !unique(before.id)
    )
      continue;
    for (const after of executions.slice(index + 1)) {
      if (
        !counterevidence.includes(after.id) ||
        !unique(after.id) ||
        !matchingSuccessfulExecution(before, after) ||
        !evidenceApplies(record, after.subjectDigest, after) ||
        latestComparable.get(comparableExecutionKey(after)) !== after
      )
        continue;
      if (matchingCommandVerifier(record, before, after, environmentChange))
        return {
          subjectDigest: after.subjectDigest,
          input: `command:${after.command}`,
          reproductionId: before.id,
          recheckId: after.id,
        };
    }
  }
  return matchingJourneyPair(record, finding, counterevidence, environmentChange);
}

function comparableExecutionKey(entry: ProductExecution) {
  // A later receipt for this same input supersedes an earlier pass, even when it failed.
  return JSON.stringify([
    entry.subjectDigest,
    entry.task,
    entry.check,
    entry.command,
    entry.contractDigest,
  ]);
}

function latestComparableExecutions(executions: readonly ProductExecution[]) {
  return new Map(executions.map((entry) => [comparableExecutionKey(entry), entry]));
}

function uniqueIds(entries: readonly { id?: string }[]) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.id) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  return (id: string) => counts.get(id) === 1;
}

function matchingSuccessfulExecution(before: ProductExecution, after: ProductExecution) {
  return (
    after.status === "passed" &&
    after.exitCode === 0 &&
    after.provenance === "supervisor-executed" &&
    after.task === before.task &&
    after.check === before.check &&
    after.command === before.command &&
    after.contractDigest === before.contractDigest
  );
}

function matchingCommandVerifier(
  record: ProductRecord,
  before: ProductExecution,
  after: ProductExecution,
  environmentChange?: RepairEnvironmentChange,
) {
  return (
    identifiedCounterexample(record, before) &&
    !before.captureRunId &&
    !after.captureRunId &&
    repairEnvironments(before, after, environmentChange) &&
    !!before.verifierDigest &&
    before.verifierDigest === after.verifierDigest
  );
}

function matchingJourneyPair(
  record: ProductRecord,
  finding: FunctionalFinding,
  counterevidence: readonly string[],
  environmentChange?: RepairEnvironmentChange,
): FunctionalRepairWitness | undefined {
  const runs = record.state.captureRuns.flatMap((input) => {
    const parsed = productCaptureRunSchema.safeParse(input);
    return parsed.success ? [parsed.data] : [];
  });
  const unique = uniqueIds(runs);
  const uniqueExecution = uniqueIds(record.state.executions);
  const intact = (run: (typeof runs)[number]) =>
    !!run.id &&
    unique(run.id) &&
    !!run.journey &&
    hashValue(run.journey) === run.journeyDigest &&
    productJourneyKey(run.journey, run.task) === run.journeyKey;
  const cited = (run: (typeof runs)[number], ids: readonly string[]) =>
    ids.includes(run.id ?? "") ||
    run.captures.some((entry) => ids.includes(entry.id)) ||
    run.operations.some((entry) => ids.includes(entry.id)) ||
    record.state.executions.some(
      (entry) =>
        entry.captureRunId === run.id &&
        uniqueExecution(entry.id) &&
        ids.includes(entry.id) &&
        entry.provenance === "supervisor-executed" &&
        entry.subjectDigest === run.subjectDigest &&
        entry.contractDigest === run.contractDigest &&
        entry.task === run.task &&
        (run.status === "completed"
          ? entry.status === "passed" && entry.exitCode === 0
          : entry.status === "failed" && entry.exitCode !== 0),
    );
  for (const [index, before] of runs.entries()) {
    if (
      !before.id ||
      !intact(before) ||
      (finding.task !== undefined && before.task !== finding.task) ||
      before.subjectDigest !== finding.subjectDigest ||
      before.status === "completed" ||
      before.failure?.kind !== "behavior" ||
      !cited(before, finding.evidence)
    )
      continue;
    const comparable = runs
      .slice(index + 1)
      .filter(
        (run) =>
          intact(run) &&
          run.task === before.task &&
          run.contractDigest === before.contractDigest &&
          run.journeyKey === before.journeyKey &&
          evidenceApplies(record, run.subjectDigest, run),
      );
    const latestBySubject = new Map(comparable.map((run) => [run.subjectDigest, run]));
    const after = comparable.find(
      (run) =>
        run.status === "completed" &&
        latestBySubject.get(run.subjectDigest) === run &&
        repairEnvironments(before, run, environmentChange) &&
        cited(run, counterevidence),
    );
    if (after?.id && after.journeyKey)
      return {
        subjectDigest: after.subjectDigest,
        input: after.journeyKey,
        reproductionId: before.id,
        recheckId: after.id,
      };
  }
  return undefined;
}
