import { evidenceApplies, productCaptureRunSchema } from "./evidence-references.js";
import type { ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";

export { OBSERVATION_REVIEW_INSTRUCTIONS } from "./review-instructions.js";

/** Labels describe recorded operations, never inferred game states or quality. */
export function observationSequence(record: ProductRecord, subject: string, slice?: ProductSlice) {
  const runs = record.state.captureRuns
    .flatMap((input) => {
      const run = productCaptureRunSchema.safeParse(input);
      return run.success &&
        evidenceApplies(record, subject, run.data) &&
        (!slice || !run.data.task || run.data.task === slice.id)
        ? [run.data]
        : [];
    })
    .reverse();
  runs.sort((a, b) => Number(a.status === "completed") - Number(b.status === "completed"));
  const seenImages = new Set<string>();
  const states = new Set<string>();
  const selected: {
    id: string;
    label: string;
    runId?: string;
    viewport: { width: number; height: number };
    runIndex: number;
    captureIndex: number;
  }[] = [];
  const omitted: string[] = [];
  for (const [runIndex, run] of runs.entries()) {
    // Endpoints plus real intermediate input states; retain a viewport's context together.
    const indices = [...new Set([0, run.captures.length - 1, ...run.captures.keys()])];
    for (const index of indices) {
      const capture = run.captures[index];
      if (!capture) continue;
      const label = captureLabel(capture.steps, index, run.captures.length, run.status);
      const state = `${capture.viewport.width}x${capture.viewport.height}:${label}`;
      if (seenImages.has(capture.sha256) || states.has(state) || selected.length >= 6) {
        omitted.push(capture.id);
        continue;
      }
      selected.push({
        id: capture.id,
        label,
        runId: run.id,
        viewport: capture.viewport,
        runIndex,
        captureIndex: index,
      });
      seenImages.add(capture.sha256);
      states.add(state);
    }
  }
  return {
    states: selected
      .sort((a, b) => a.runIndex - b.runIndex || a.captureIndex - b.captureIndex)
      .map(({ runIndex: _runIndex, captureIndex: _captureIndex, ...state }) => state),
    omittedCaptureIds: omitted,
    limitation:
      "Operation-derived labels, not semantic state recognition. Original run provenance is retained; identical images are delivered once. Missing states and image-budget omissions remain explicit.",
  };
}

/** Preserve endpoint precedence; step text describes operations, not inferred outcomes. */
function captureLabel(
  steps: readonly string[],
  index: number,
  count: number,
  status: string | undefined,
) {
  if (index === 0) return "initial recorded state";
  if (index === count - 1)
    return status === "completed" ? "final recorded state" : "failure recorded state";
  const text = steps.at(-1) ?? "";
  if (/Finish .*drag/.test(text)) return "after drag release";
  if (/Begin .*drag/.test(text)) return "held drag";
  return text ? `intermediate recorded state: ${text}` : "intermediate recorded state";
}
