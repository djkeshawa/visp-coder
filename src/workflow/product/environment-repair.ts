import { type FunctionalFinding, findFunctionalRepair } from "./functional-resolution.js";
import type { ProductRecord } from "./store.js";

interface Observation {
  readonly id?: string;
  readonly comparisonEnvironment?: string;
}

/** Evidence may support a question about an environment repair, never an automatic assessment. */
export function environmentRepairCandidate(
  record: ProductRecord,
  finding: FunctionalFinding & { readonly dimension?: string },
  before: Observation,
  after: Observation | undefined,
  subject: string,
) {
  if (finding.dimension !== "functional") return undefined;
  const from = before.comparisonEnvironment;
  const to = after?.comparisonEnvironment;
  if (!from?.trim() || !to?.trim() || from === to || !after?.id) return undefined;
  const change = { from, to };
  if (findFunctionalRepair(record, finding, [after.id], change)?.subjectDigest !== subject)
    return undefined;
  return {
    ...change,
    requiresAssessment: true as const,
    guidance:
      "Assess whether this observed environment change repairs the defect while preserving intended behavior. If justified, supply environmentChange with these from/to identities and an explanation, plus adjacent regression assessment. The original finding remains unresolved until assessment; this is not a disproof.",
  };
}
