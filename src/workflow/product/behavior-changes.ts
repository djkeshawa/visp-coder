import { hashValue } from "../../core/hash.js";
import { type BrowserJourney, browserJourneySchema } from "../../testing/browser-journey.js";
import { comparableEnvironments } from "./comparison-environment.js";
import { productCaptureRunSchema } from "./evidence-references.js";
import type { ProductExecution } from "./model.js";
import type { ProductRecord } from "./store.js";

interface Observation {
  id: string;
  subjectDigest: string;
  contractDigest?: string;
  comparisonEnvironment?: string;
  status?: string;
  failure?: { kind: string; message: string };
  output?: string;
  operations?: readonly {
    description?: string;
    measurement?: { json: string; truncated: boolean };
  }[];
  captures?: readonly { id: string }[];
}

const comparableCapture = productCaptureRunSchema.extend({
  journey: browserJourneySchema.optional(),
});

/** Related inputs are comparison leads only; different waits can change execution timing. */
function inputSequence(run: { journey?: BrowserJourney; journeyDigest?: string }) {
  if (!run.journey || hashValue(run.journey) !== run.journeyDigest) return undefined;
  const actions = run.journey.actions
    .filter((action) => action.kind !== "wait-for")
    .map(({ capture: _capture, ...action }) => {
      if (action.kind !== "drag") return action;
      const { captureDuring: _heldCapture, ...input } = action;
      return input;
    });
  return actions.length
    ? hashValue({ url: run.journey.url, viewport: run.journey.viewport, actions })
    : undefined;
}

/** Historical observations are comparisons, never fresh acceptance evidence. */
export function compareObservations(before: Observation | undefined, after: Observation) {
  if (!before) return undefined;
  const comparable = comparableEnvironments(before, after);
  const environmentFailure = [before, after].some(
    (run) =>
      run.status === "environment-failed" ||
      run.status === "cancelled" ||
      (run.status === "timed-out" && !run.failure) ||
      (run.failure && run.failure.kind !== "behavior"),
  );
  const passed = (run: Observation) => ["completed", "passed"].includes(run.status ?? "");
  const change = !comparable
    ? "environment-unconfirmed"
    : environmentFailure
      ? "execution-gap"
      : passed(before) && !passed(after)
        ? "possible-regression"
        : !passed(before) && passed(after)
          ? "recovered-execution"
          : "compare-observations";
  return {
    change,
    sameSubject: before.subjectDigest === after.subjectDigest,
    before: describeObservation(before),
    after: describeObservation(after),
    guidance:
      "Compare the actual behavior and images. A passing run does not establish quality; changed output may be expected. Historical images are references, not current evidence. Preserve working behavior while investigating differences.",
  };
}

export function describeObservation(run: Observation) {
  return {
    runId: run.id,
    subjectDigest: run.subjectDigest,
    status: run.status,
    detail: (run.failure?.message ?? run.output ?? "").slice(-1200),
    detailTruncated: (run.failure?.message ?? run.output ?? "").length > 1200,
    measurements:
      run.operations
        ?.filter((operation) => operation.measurement)
        .slice(-3)
        .map((operation) => ({
          description: operation.description?.slice(0, 240),
          json: operation.measurement?.json.slice(0, 1200),
          truncated:
            operation.measurement?.truncated || (operation.measurement?.json.length ?? 0) > 1200,
        })) ?? [],
    captureIds: run.captures?.slice(-6).map((capture) => capture.id) ?? [],
  };
}

export function captureBehaviorChange(record: ProductRecord, candidate: unknown) {
  const parsed = comparableCapture.safeParse(candidate);
  if (
    !parsed.success ||
    !parsed.data.id ||
    !parsed.data.journeyDigest ||
    !parsed.data.contractDigest
  )
    return undefined;
  const after = parsed.data;
  const inputs = inputSequence(after);
  let before: Observation | undefined;
  let sameJourney = true;
  for (const entry of record.state.captureRuns) {
    const run = comparableCapture.safeParse(entry);
    if (
      run.success &&
      run.data.id &&
      run.data.id !== after.id &&
      run.data.task === after.task &&
      (run.data.journeyDigest === after.journeyDigest ||
        (inputs && inputSequence(run.data) === inputs)) &&
      run.data.contractDigest === after.contractDigest
    ) {
      before = { ...run.data, id: run.data.id };
      sameJourney = run.data.journeyDigest === after.journeyDigest;
    }
  }
  const compared = compareObservations(before, { ...after, id: parsed.data.id });
  if (!compared || sameJourney) return compared;
  return {
    ...compared,
    sameJourney: false,
    change: ["environment-unconfirmed", "execution-gap"].includes(compared.change)
      ? compared.change
      : "revised-observation",
    guidance:
      "The selected inputs match an earlier run, but observation expectations or capture timing changed. Compare both actual results and images; a new passing assertion is not proof of a product repair. Different waits may affect timing. Preserve the original behavior goal rather than changing behavior to fit a test route. This comparison grants no recovery or acceptance credit.",
  };
}

export function checkBehaviorChanges(
  previous: readonly ProductExecution[],
  current: readonly ProductExecution[],
) {
  const changes = current.flatMap((after) => {
    const before = previous.findLast(
      (entry) =>
        entry.id !== after.id &&
        entry.check === after.check &&
        entry.task === after.task &&
        entry.command === after.command &&
        entry.contractDigest === after.contractDigest &&
        entry.provenance === "supervisor-executed",
    );
    if (after.provenance !== "supervisor-executed") return [];
    const change = compareObservations(before, after);
    if (
      before?.status === after.status &&
      before?.output === after.output &&
      before?.comparisonEnvironment === after.comparisonEnvironment
    )
      return [];
    return change
      ? [
          {
            check: after.check,
            ...change,
            outputChanged: hashValue(before?.output) !== hashValue(after.output),
          },
        ]
      : [];
  });
  changes.sort(
    (a, b) =>
      Number(b.change === "possible-regression") - Number(a.change === "possible-regression"),
  );
  return { checks: changes.slice(0, 3), omitted: Math.max(0, changes.length - 3) };
}
