import type { ProductFeedback } from "../../../src/workflow/product/feedback-model.js";
import type { ProductReviewBundle } from "../../../src/workflow/product/review.js";

/** Explicit reviewer fixture for small non-UI modules; never used by production code. */
export function moduleFeedback(bundle: ProductReviewBundle): ProductFeedback {
  const implementation = bundle.sources.filter(
    (entry) => entry.kind === "implementation-file" && entry.available,
  );
  return {
    phase: "product",
    probes: (bundle.agenda?.behavioralProbes.probes ?? []).map((probe) => ({
      kind: probe.kind as "independent-result" | "repeat-and-recover" | "rendered-usability",
      expected: "The public module returns the value required by the fixture verifier.",
      basis: "The fixture verifier independently asserts the expected exported value.",
      exercise: "Execute the public module through its Node verifier.",
      observed:
        probe.kind === "repeat-and-recover"
          ? "This constant export has no mutable lifecycle, retry or cancellation."
          : "The verifier reports the expected value.",
      status:
        probe.kind === "repeat-and-recover" ? ("not-applicable" as const) : ("satisfied" as const),
      evidence:
        probe.kind === "repeat-and-recover"
          ? implementation.map((entry) => entry.id)
          : bundle.evidence
              .filter((entry) => entry.kind === "execution" && entry.status === "available")
              .slice(0, 1)
              .map((entry) => entry.id),
    })),
    dimensions: [
      {
        dimension: "fidelity",
        status: "satisfied",
        reason:
          "The preserved request and the retained public-module checks address the same behavior.",
        evidence: ["SRC-REQUEST"],
      },
      {
        dimension: "functional",
        status: "satisfied",
        reason:
          "The fixture verifier executed the public module and compared its returned value with the expected result.",
        evidence: bundle.evidence
          .filter((entry) => entry.kind === "execution" && entry.status === "available")
          .slice(0, 1)
          .map((entry) => entry.id),
      },
      {
        dimension: "non-functional",
        status: "not-applicable",
        reason:
          "This isolated constant-value fixture has no additional resource, concurrency or deployment promises.",
        evidence: [],
      },
      {
        dimension: "experience",
        status: "not-applicable",
        reason: "This fixture exposes a module, with no rendered user interface.",
        evidence: [],
      },
      {
        dimension: "code",
        status: implementation.length ? "satisfied" : "not-applicable",
        reason:
          "The supplied module has a single explicit public value and no lifecycle or duplicated state ownership.",
        evidence: implementation.map((entry) => entry.id),
      },
    ],
    findings: [],
    resolutions: [],
  };
}
