import { type ProductEvidenceCatalogue, productCaptureRunSchema } from "./evidence-references.js";
import type { ProductFeedback } from "./feedback-model.js";
import {
  type FunctionalFinding,
  type FunctionalRepairWitness,
  witnessedFunctionalExecutions,
} from "./functional-resolution.js";
import type { ProductExecution } from "./model.js";
import type { ProductRecord } from "./store.js";

export const functionalRegressionRequirement =
  "Functional repair requires an adjacent regression check or an assessed reason it does not apply";

export function functionalRegressionEvidenceGap(
  record: ProductRecord,
  finding: FunctionalFinding,
  resolution: ProductFeedback["resolutions"][number],
  repair: FunctionalRepairWitness,
  catalogue: ProductEvidenceCatalogue,
): string | undefined {
  const regression = resolution.regression;
  if (!regression) return functionalRegressionRequirement;
  if (regression.kind === "not-applicable") return undefined;
  const entries = regression.evidence.map((id) =>
    catalogue.entries.find((entry) => entry.id === (catalogue.aliases.get(id) ?? id)),
  );
  if (entries.some((entry) => entry?.status !== "available" || entry.kind !== "execution"))
    return "Adjacent regression requires current successful execution references";
  const ids = entries.flatMap((entry) => (entry ? [entry.id] : []));
  const witnesses = witnessedFunctionalExecutions(record, finding, ids);
  if (witnesses.length !== new Set(ids).size)
    return "Adjacent regression requires uniquely identified successful behavioral executions in the finding's scope";
  const regressions = executionInputs(record, witnesses);
  if (
    regressions.some(
      (regression) =>
        repair.subjectDigest !== regression.subject || repair.input === regression.input,
    )
  )
    return "The adjacent regression must exercise a distinct input or check on the same repaired product";
  return undefined;
}

/** Compare actual command/journey identity, not a second label for the repair receipt. */
function executionInputs(record: ProductRecord, executions: readonly ProductExecution[]) {
  const journeys = new Map(
    record.state.captureRuns.flatMap((input) => {
      const parsed = productCaptureRunSchema.safeParse(input);
      return parsed.success && parsed.data.id
        ? [[parsed.data.id, parsed.data.journeyKey] as const]
        : [];
    }),
  );
  return executions.map((entry) => ({
    subject: entry.subjectDigest,
    input: entry.captureRunId ? journeys.get(entry.captureRunId) : `command:${entry.command}`,
  }));
}
