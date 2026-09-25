import { type FunctionalFinding, findFunctionalRepair } from "./functional-resolution.js";
import { findingReproductions } from "./reproduction-bindings.js";
import type { ProductRecord } from "./store.js";

export interface FindingReference extends FunctionalFinding {
  readonly dimension?: string;
}

interface Observation {
  readonly id: string;
  readonly subjectDigest: string;
  readonly comparisonEnvironment?: string;
}

/** Prefer an established witness; otherwise retain the reported or attached reproduction. */
export function selectRepairReproduction(
  record: ProductRecord,
  finding: FindingReference,
  subject: string,
  observations: readonly Observation[],
) {
  const witness =
    finding.dimension === "functional"
      ? (findFunctionalRepair(
          record,
          finding,
          observations.filter((entry) => entry.subjectDigest === subject).map((entry) => entry.id),
        ) ?? observedEnvironmentWitness(record, finding, subject, observations))
      : undefined;
  const witnessed = witness && observations.find((entry) => entry.id === witness.reproductionId);
  const attached = findingReproductions(record, finding).at(-1);
  return witnessed
    ? { subjectDigest: witnessed.subjectDigest, evidence: [witnessed.id] }
    : attached
      ? { subjectDigest: attached.subjectDigest, evidence: [attached.execution] }
      : finding;
}

/** Search observed identities only; a candidate still needs explicit environment assessment. */
function observedEnvironmentWitness(
  record: ProductRecord,
  finding: FindingReference,
  subject: string,
  observations: readonly Observation[],
) {
  const environments = new Set(
    observations.map((entry) => entry.comparisonEnvironment).filter((value) => value?.trim()),
  );
  for (const to of environments) {
    if (!to) continue;
    const current = observations
      .filter((entry) => entry.subjectDigest === subject && entry.comparisonEnvironment === to)
      .map((entry) => entry.id);
    if (!current.length) continue;
    for (const from of environments) {
      if (!from || from === to) continue;
      const witness = findFunctionalRepair(record, finding, current, { from, to });
      if (witness?.subjectDigest === subject) return witness;
    }
  }
  return undefined;
}
