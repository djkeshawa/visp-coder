import { productBehaviorProbes } from "./behavior-probes.js";
import type { ProductSlice } from "./model.js";
import { currentProbeResponses } from "./probe-feedback.js";
import type { ProductRecord } from "./store.js";

/** Observation counts cannot establish semantic coverage; keep each unanswered probe visible. */
export function productObservationPlan(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
) {
  const responses = currentProbeResponses(record, subject, slice);
  return {
    session:
      "For browser checks: use the same browser session and one journey.actions array. Captures start fresh.",
    sequence: [
      "Real input → assert settled result → input again → assert settled result",
      "If applicable: reset/cancel pending work → restart → outlive old completion; new state stays intact",
    ],
    probes: productBehaviorProbes(record, slice)
      .probes.filter(
        (probe) =>
          !["satisfied", "not-applicable"].includes(responses.get(probe.kind)?.status ?? ""),
      )
      .map((probe) => ({
        kind: probe.kind,
        status: responses.get(probe.kind)?.status ?? "unassessed",
      })),
    review:
      "Compare results to independent expectations; explain non-applicability. Full probes: visp review --template.",
  };
}
