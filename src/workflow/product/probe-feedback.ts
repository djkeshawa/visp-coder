import { vispError } from "../../core/errors.js";
import { err, ok } from "../../core/result.js";
import { productBehaviorProbes } from "./behavior-probes.js";
import { type ProductEvidenceCatalogue, supportsBehaviorEvidence } from "./evidence-references.js";
import type { ProductFeedback } from "./feedback-model.js";
import type { ProductReviewerContext, ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";

type Response = NonNullable<ProductFeedback["probes"]>[number];

/** Keep judgments separate from execution: a linked run is necessary, never proof of the claim. */
export function validateProbeResponses(
  feedback: ProductFeedback,
  record: ProductRecord,
  catalogue: ProductEvidenceCatalogue,
  reviewer: ProductReviewerContext,
  slice?: ProductSlice,
) {
  const probes = productBehaviorProbes(record, slice).probes;
  const responses = feedback.probes ?? [];
  if (
    new Set(responses.map((entry) => entry.kind)).size !== responses.length ||
    responses.some((entry) => !probes.some((probe) => probe.kind === entry.kind))
  )
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Probe responses must name distinct probes in the selected review",
      ),
    );
  return ok(
    responses.map((response): Response => {
      response = {
        ...response,
        evidence: response.evidence.map((id) => catalogue.aliases.get(id) ?? id),
      };
      if (response.status === "failed") return response;
      if (reviewer.context === "unavailable") return { ...response, status: "unavailable" };
      const refs = response.evidence.map((id) =>
        catalogue.entries.find((entry) => entry.id === (catalogue.aliases.get(id) ?? id)),
      );
      const outcomes = probes.find((probe) => probe.kind === response.kind)?.outcomes ?? [];
      const available = refs.filter(
        (entry) =>
          entry?.status === "available" &&
          (!entry.outcomes.length || entry.outcomes.some((outcome) => outcomes.includes(outcome))),
      );
      const execution = available.some((entry) => entry && supportsBehaviorEvidence(entry));
      const image = available.some((entry) => entry?.kind === "image");
      const inapplicable =
        response.status === "not-applicable" &&
        response.kind === "repeat-and-recover" &&
        available.some((entry) => entry?.id.startsWith("CODE-"));
      const observed =
        response.status === "satisfied" &&
        execution &&
        (response.kind !== "rendered-usability" || image) &&
        refs.every((entry) => entry?.status === "available");
      if (inapplicable || observed || ["unclear", "unavailable"].includes(response.status))
        return response;
      return {
        ...response,
        status: "unclear",
        observed: `${response.observed.slice(0, 1200)}\nLink current execution of the exercised behavior${response.kind === "rendered-usability" ? " and inspected images" : ""}; only repeat/recovery may be inapplicable, with source evidence explaining why.`,
      };
    }),
  );
}

/** Answers expire with the same subject/contract as other review judgments. Partial repairs retain peers. */
export function currentProbeResponses(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
) {
  const latest = new Map<string, Response>();
  const selectedProbes = productBehaviorProbes(record, slice).probes;
  const assembled = !slice && record.brief.slices.length > 1;
  for (const review of record.state.reviews) {
    const owner = record.brief.slices.find((entry) => entry.id === review.task);
    if (!probeReviewApplies(review, record, subject, slice, owner)) continue;
    const originProbes = productBehaviorProbes(record, owner).probes;
    for (const response of review.feedback?.probes ?? []) {
      // A slice answer cannot silently answer an assembled multi-slice product question.
      if (assembled && review.task) continue;
      if (!sameProbe(originProbes, selectedProbes, response.kind)) continue;
      latest.set(response.kind, response);
    }
  }
  return latest;
}

export function probeFeedbackGaps(record: ProductRecord, subject: string, slice?: ProductSlice) {
  const responses = currentProbeResponses(record, subject, slice);
  return productBehaviorProbes(record, slice).probes.flatMap((probe) => {
    const response = responses.get(probe.kind);
    return response && ["satisfied", "not-applicable"].includes(response.status)
      ? []
      : [
          `${probe.kind}: ${response?.status ?? "unassessed"}; ${response?.observed ?? probe.question}`,
        ];
  });
}

function sameProbe(
  origin: ReturnType<typeof productBehaviorProbes>["probes"],
  selected: ReturnType<typeof productBehaviorProbes>["probes"],
  kind: string,
) {
  const id = origin.find((probe) => probe.kind === kind)?.id;
  return id !== undefined && id === selected.find((probe) => probe.kind === kind)?.id;
}

function probeReviewApplies(
  review: ProductRecord["state"]["reviews"][number],
  record: ProductRecord,
  subject: string,
  slice: ProductSlice | undefined,
  owner: ProductSlice | undefined,
) {
  return (
    review.policyVersion === 5 &&
    review.subjectDigest === subject &&
    review.feedback?.phase === "product" &&
    (!review.task || !!owner) &&
    (!slice || !review.task || slice.id === review.task) &&
    review.contractDigest === productContractDigest(record.brief, owner)
  );
}
