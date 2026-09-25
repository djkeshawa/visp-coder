import type { CriticPacket } from "../../../src/workflow/product/critic-packet.js";
import {
  type ProductFeedback,
  QUALITY_DIMENSIONS,
} from "../../../src/workflow/product/feedback-model.js";
import { assessmentSchema } from "../../../src/workflow/product/model.js";
/** Exercises persisted pre-independent-review response compatibility, not the new provider contract. */
export function legacyReview(packet: CriticPacket) {
  return {
    subjectDigest: packet.current.subjectDigest,
    selection: packet.selection,
    assessments:
      packet.phase === "understanding"
        ? []
        : packet.current.outcomes.map((outcome) =>
            assessmentSchema.parse({
              outcome: outcome.id,
              status: "unclear",
              summary: "Not assessed",
              evidence: [],
              expectations: [],
            }),
          ),
    feedback: {
      phase: packet.phase ?? "product",
      dimensions: QUALITY_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "unclear" as "satisfied" | "failed" | "unclear" | "unavailable" | "not-applicable",
        reason: "Not assessed",
        evidence: [] as string[],
      })),
      findings: [] as ProductFeedback["findings"],
      resolutions: [] as ProductFeedback["resolutions"],
    },
  };
}
