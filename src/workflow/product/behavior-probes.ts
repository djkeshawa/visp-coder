import { hashValue } from "../../core/hash.js";
import type { ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";

/** Derived counterexamples to shallow checks; no new authored artifact or mandatory feature. */
export function productBehaviorProbes(record: ProductRecord, slice?: ProductSlice) {
  const outcomes = record.brief.outcomes.filter(
    (entry) => !slice || slice.outcomes.includes(entry.id),
  );
  const functional = outcomes.filter((entry) => entry.kind === "functional");
  const examples = record.brief.examples.filter((entry) =>
    entry.outcomes.some((id) => functional.some((outcome) => outcome.id === id)),
  );
  const example =
    examples.find((entry) =>
      /\b(click|drag|drags|release|releases|submit|press|type|tap|retry|reset|cancel|select|save|delete|request)\b/i.test(
        entry.when,
      ),
    ) ?? examples[0];
  const anchor = example
    ? {
        example: example.id,
        when: example.when.slice(0, 400),
        expected: example.expected.slice(0, 2).map((entry) => entry.slice(0, 400)),
        outcomes: example.outcomes.filter((id) => functional.some((outcome) => outcome.id === id)),
      }
    : {
        when: functional[0]?.statement.slice(0, 400) ?? "",
        expected: functional.slice(0, 2).map((entry) => entry.statement.slice(0, 400)),
        outcomes: functional.slice(0, 2).map((entry) => entry.id),
      };
  const probes = [];
  if (functional.length) {
    probes.push({
      kind: "independent-result",
      ...anchor,
      question:
        "State the expected result independently of this implementation. Where input should affect the outcome, exercise two inputs with different expected results (for example hit/miss or valid/invalid) and compare actual settled results. Reject decorative controls or canned success. A state flag or matching preview is not an independent oracle. Identify retained expectations or label your expectation agent-proposed.",
    });
    if (
      example ||
      functional.some((outcome) =>
        /\b(reset|retry|cancel|repeat|interrupt|async|session|state|launch|submit|save|delete)\b/i.test(
          outcome.statement,
        ),
      )
    )
      probes.push({
        kind: "repeat-and-recover",
        ...anchor,
        question:
          "Exercise the behavior twice. If reset, retry or cancellation exists, trigger it while work is pending, start again, then wait beyond the old completion: old work must not change the new state. Verify the relevant alternate ending. Trace input → state owner → completion/cleanup → next input. Explain non-applicability instead of inventing features.",
      });
  }
  const experience = outcomes.find((entry) => entry.kind === "experience");
  if (experience)
    probes.push({
      kind: "rendered-usability",
      when: experience.statement.slice(0, 400),
      expected: [experience.statement.slice(0, 400)],
      outcomes: [experience.id],
      question:
        "Compare the primary activity, instructions and result at the observed viewports. Inspect canvas proportions, primary activity size, overlay occlusion, control proximity, rendered input target sizes and consistency of displayed values. Review runner layout measurements alongside the actual image; intentional cropping or scrolling needs contextual judgment. A coherent palette or one winning input does not establish usable controls. Preserve working behavior during visual corrections.",
    });
  return {
    probes: probes
      .slice(0, 3)
      .map((probe) => ({ ...probe, id: `PROBE-${hashValue(probe).slice(0, 12)}` })),
    guidance:
      "Answer these bounded questions in feedback.probes with the independently expected behavior, its basis, the actual exercise, observed result and current evidence. These do not add product features or prove coverage. Put consequential failures in existing feedback findings and keep unsupported promised behavior unclear. Extend an existing executable check when a probe reveals a missing assertion; do not maintain a separate probe document.",
  };
}
