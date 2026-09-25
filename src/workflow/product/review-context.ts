import { z } from "zod";
import { productBehaviorProbes } from "./behavior-probes.js";
import { evidenceApplies, productCaptureRunSchema } from "./evidence-references.js";
import { checksFor, type ProductSlice } from "./model.js";
import { summarizeLayout, summarizeObservation } from "./observation-summary.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";

/** A read-only agenda from the one brief; it does not create another authored contract. */
export function productReviewAgenda(record: ProductRecord, slice?: ProductSlice) {
  const relevant = new Set(slice?.outcomes ?? record.brief.outcomes.map((outcome) => outcome.id));
  const examples = record.brief.examples.filter((entry) =>
    entry.outcomes.some((id) => relevant.has(id)),
  );
  const decisions = record.brief.decisions.filter(
    (entry) => !entry.outcomes.length || entry.outcomes.some((id) => relevant.has(id)),
  );
  const checks = checksFor(record.brief, slice);
  const visualOutcomes = record.brief.outcomes.filter(
    (outcome) => relevant.has(outcome.id) && outcome.kind === "experience",
  );
  const design = record.brief.design;
  const visualPrompts = visualOutcomes.slice(0, 4).map((outcome) => ({
    outcome: outcome.id,
    prompt: `For “${outcome.statement.slice(0, 360)}”, compare the primary activity's usable area with surrounding chrome at each observed viewport. Can the player or user see the activity, its status and essential controls together without losing context through scrolling? Inspect actual input, intermediate feedback, settled result and recovery. Assess composition, visual hierarchy, proportions/aspect ratio and material or character treatment; a visible canvas and coherent palette alone do not establish aesthetic quality. Check target size at the rendered scale; a large helper button does not demonstrate that the primary drag/touch target is usable. Identify at most three consequential mismatches with the retained design, supported by an image or measurement. Judge only observed inputs and viewports; desktop pixels do not establish mobile quality.`,
  }));
  return {
    goal: (slice?.goal ?? record.brief.goal).slice(0, 1000),
    ...(design
      ? {
          design: {
            description: design.description.slice(0, 2400),
            references: design.references.slice(0, 6),
            guidance:
              "Compare observed layout and interaction with this retained design direction and any accessible references. State which references were inspected; an uninspected reference is context, not proof. Agent-proposed visual techniques are revisable hypotheses, not user requirements. Change them when the actual result fails the requested experience; preserve independently supplied constraints. Additional reference collection and refinement cycles are optional.",
          },
        }
      : {}),
    behavioralProbes: productBehaviorProbes(record, slice),
    visualPrompts,
    examples: examples.slice(0, 6),
    decisions: decisions
      .slice(0, 4)
      .map(({ id, statement, rationale, implications, outcomes }) => ({
        id,
        statement,
        rationale,
        implications,
        outcomes,
      })),
    uncertainties: record.brief.uncertainties.slice(0, 6),
    checks: checks.slice(0, 12),
    acceptanceBaseline: record.brief.acceptanceBaseline,
    omitted: {
      examples: Math.max(0, examples.length - 6),
      decisions: Math.max(0, decisions.length - 4),
      uncertainties: Math.max(0, record.brief.uncertainties.length - 6),
      checks: Math.max(0, checks.length - 12),
      goalCharacters: Math.max(0, (slice?.goal ?? record.brief.goal).length - 1000),
      designDescriptionCharacters: Math.max(0, (design?.description.length ?? 0) - 2400),
      designReferences: Math.max(0, (design?.references.length ?? 0) - 6),
      visualPrompts: Math.max(0, visualOutcomes.length - 4),
    },
    guidance:
      "Use these retained examples and uncertainties to select meaningful observations. Check whether the evidence demonstrates each promise; a declared check mapping is not proof of coverage. Challenge the most consequential plausible false positive with a focused countercheck as well as a legitimate success. Do not change success conditions or disable behavior merely to make a chosen journey pass. A miss or different valid input is not automatically a product defect. Unspecified viewports and recovery behavior are questions, not additional mandatory requirements.",
  };
}

/** Runner operations distinguish touching the primary control from a pointer click at a mobile viewport. */
export function reviewInteractionEvidence(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
) {
  const runs = record.state.captureRuns.flatMap((candidate) => {
    const parsed = productCaptureRunSchema.safeParse(candidate);
    if (
      !parsed.success ||
      !evidenceApplies(record, subject, parsed.data) ||
      (slice && parsed.data.task && parsed.data.task !== slice.id)
    )
      return [];
    const run = parsed.data;
    return [
      {
        runId: run.id,
        status: run.status ?? "historical",
        viewports: [
          ...new Set(
            run.captures.map((entry) => `${entry.viewport.width}x${entry.viewport.height}`),
          ),
        ],
        observations: run.operations
          .filter((entry) => entry.kind === "observe")
          .map(summarizeObservation),
        layout: run.operations
          .filter((entry) => entry.kind === "measure")
          .flatMap((entry) =>
            summarizeLayout(entry, new Set(run.captures.map((capture) => capture.id))),
          ),
        inputs: run.operations
          .filter((entry) => ["pointer", "touch", "keyboard"].includes(entry.kind))
          .map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            description: entry.description?.slice(0, 240),
          })),
      },
    ];
  });
  // Keep a representative run for each viewport/input combination, not every repeated launch.
  const representatives = new Map<string, (typeof runs)[number]>();
  for (const run of runs)
    representatives.set(
      JSON.stringify([
        run.viewports,
        [...new Set(run.inputs.map((entry) => entry.kind))].sort(),
        run.status,
        run.observations.map((entry) => entry.expected),
      ]),
      run,
    );
  return {
    runs: [...representatives.values()].slice(-6).map((run) => ({
      ...run,
      observations: run.observations.slice(-6),
      omittedObservations: Math.max(0, run.observations.length - 6),
      layout: run.layout.slice(-3),
      omittedLayouts: Math.max(0, run.layout.length - 3),
      layoutAvailability: run.layout.length
        ? "Measured geometry requires image review"
        : "No complete runner layout measurement; inspect the image directly or recapture if needed",
      inputs: run.inputs.slice(0, 8),
      omittedInputs: Math.max(0, run.inputs.length - 8),
    })),
    omittedRuns: Math.max(0, representatives.size - 6),
    guidance:
      "Compare these recorded input targets with the brief's promised controls. A mobile viewport is not touch execution; clicking a helper is not dragging the primary target. Operations establish what was exercised, not usability. Keep unobserved promised paths unresolved. After a layout-only correction, recapture affected viewports and rerun the affected interaction; reuse unchanged evidence and preserve working behavior.",
  };
}

/** Shown operation IDs only; layout capture IDs may refer to undelivered images. */
export function reviewInteractionEvidenceIds(
  interactionEvidence: ReturnType<typeof reviewInteractionEvidence>,
): string[] {
  return [
    ...new Set(
      interactionEvidence.runs.flatMap((run) => [
        ...run.observations.map((entry) => entry.id),
        ...run.layout.map((entry) => entry.id),
        ...run.inputs.map((entry) => entry.id),
      ]),
    ),
  ];
}

/** The summary and catalogue have independent bounds; either can deliver a reference. */
export function deliveredReviewEvidenceIds(
  evidence: readonly { id: string; status: string }[],
  interactionEvidence: ReturnType<typeof reviewInteractionEvidence>,
): string[] {
  return [
    ...new Set([
      ...evidence.filter((entry) => entry.status !== "not-delivered").map((entry) => entry.id),
      ...reviewInteractionEvidenceIds(interactionEvidence),
    ]),
  ];
}

/** Outcome overlap carries assembled-product findings back into a reopened slice. */
export function previousReviewAssessments(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
) {
  return record.state.reviews
    .filter(
      (review) =>
        !slice ||
        review.assessments.some((assessment) => slice.outcomes.includes(assessment.outcome)),
    )
    .slice(-3)
    .map((review) => {
      const owner = review.task
        ? record.brief.slices.find((entry) => entry.id === review.task)
        : undefined;
      return {
        subjectDigest: review.subjectDigest,
        current:
          (!review.task || owner !== undefined) &&
          review.subjectDigest === subject &&
          review.contractDigest === productContractDigest(record.brief, owner),
        assessments: review.assessments.filter(
          (assessment) => !slice || slice.outcomes.includes(assessment.outcome),
        ),
      };
    });
}

const runSchema = z.object({
  subjectDigest: z.string(),
  task: z.string().optional(),
  createdAt: z.string(),
  captures: z.array(z.object({ id: z.string() })),
});

/** Keep one relevant before/after journey together within the image delivery cap. */
export function preferredReviewCaptures(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
): string[] {
  const runs = record.state.captureRuns.flatMap((run, index) => {
    const parsed = runSchema.safeParse(run);
    if (!parsed.success || parsed.data.subjectDigest !== subject) return [];
    const owner = record.brief.slices.find((entry) => entry.id === parsed.data.task);
    if (slice && parsed.data.task && !owner?.outcomes.some((id) => slice.outcomes.includes(id)))
      return [];
    return [{ ...parsed.data, index }];
  });
  runs.sort(
    (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.index - a.index,
  );
  return runs[0]?.captures.map((capture) => capture.id) ?? [];
}
