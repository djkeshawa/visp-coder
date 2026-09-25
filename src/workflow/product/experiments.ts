import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import {
  currentFailedJourneys,
  evidenceApplies,
  latestCurrentJourneys,
  type ProductEvidenceCatalogue,
  productCaptureRunSchema,
  sameJourneyIntent,
} from "./evidence-references.js";
import { type ExperimentResolution, experimentResolutionsSchema } from "./experiment-model.js";
import { hasExecutedDeclaredRevision, isDeclaredJourney } from "./journey-ownership.js";
import type { ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";

export function experimentReviewContext(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
) {
  const failed = currentFailedJourneys(record, subject, slice?.id);
  return {
    failures: failed.slice(-3).map((run) => ({
      runId: run.id,
      kind: run.failure?.kind,
      message: run.failure?.message,
      declaredCheck: isDeclaredJourney(record, run),
      captureIds: run.captures.slice(-2).map((entry) => entry.id),
    })),
    replacements: failed.length
      ? latestCurrentJourneys(record, subject, slice?.id)
          .filter((run) => run.version === 2 && run.status === "completed")
          .slice(-3)
          .map((run) => ({
            runId: run.id,
            task: run.task,
            observations: run.operations
              .filter((entry) => entry.kind === "observe")
              .slice(-3)
              .map((entry) => entry.id),
            captureIds: run.captures.slice(-2).map((entry) => entry.id),
          }))
      : [],
    guidance:
      "A failed experiment remains unresolved unless its exact journey passes or a reviewer explicitly identifies a mistaken expectation. To diagnose an exploratory failure or an obsolete declared assertion after its revised check passes, submit experimentResolutions with runId, replacementRunId, outcome, reason, and evidence citing the replacement's successful observation and delivered image. Explain why the preserved outcome requires the replacement expectation. Current declared checks must be rerun or revised in the brief; the same declared check must execute successfully before diagnosing its obsolete assertion. Raw history remains unchanged; this judgment does not establish product quality.",
  };
}

/** Tool-owned references for a host's diagnosis; never an automatic resolution or critic hint. */
export function experimentRecoverySuggestions(
  record: ProductRecord,
  subject: string,
  slice: ProductSlice | undefined,
  catalogue: ProductEvidenceCatalogue,
) {
  const runs = latestCurrentJourneys(record, subject, slice?.id);
  const available = new Set(
    catalogue.entries.filter((entry) => entry.status === "available").map((entry) => entry.id),
  );
  return currentFailedJourneys(record, subject, slice?.id)
    .filter((run) => run.failure?.kind === "behavior")
    .slice(-3)
    .flatMap((failure) => {
      const owner = record.brief.slices.find((entry) => entry.id === failure.task);
      const outcomes = record.brief.outcomes
        .filter(
          (outcome) =>
            (!slice || slice.outcomes.includes(outcome.id)) &&
            (!owner || owner.outcomes.includes(outcome.id)),
        )
        .map((outcome) => outcome.id);
      if (!failure.id || !outcomes.length) return [];
      const candidates = runs
        .filter(
          (run) =>
            run.version === 2 &&
            run.status === "completed" &&
            sameJourneyIntent(failure, run) &&
            failedInputReplayed(failure, run),
        )
        .slice(-3)
        .reverse();
      for (const replacement of candidates) {
        const observation = replacement.operations.findLast(
          (operation) => operation.kind === "observe" && available.has(operation.id),
        );
        const image = replacement.captures.findLast(
          (capture) =>
            available.has(capture.id) &&
            failure.captures.some(
              (previous) =>
                previous.route === capture.route &&
                previous.viewport.width === capture.viewport.width &&
                previous.viewport.height === capture.viewport.height,
            ),
        );
        if (!observation || !image) continue;
        const draft = {
          runId: failure.id,
          replacementRunId: replacement.id,
          outcome: outcomes[0] as string,
          reason: "Candidate only; no diagnosis has been supplied",
          evidence: [observation.id, image.id],
        };
        // Reuse the submission boundary so suggestions cannot bypass input, freshness or scope rules.
        if (!validateExperimentResolutions([draft], record, subject, slice, catalogue).ok) continue;
        return [
          {
            advisory: true,
            message: failure.failure?.message,
            outcomes,
            submission: {
              assessments: [],
              reviewer: { context: "unspecified" as const },
              experimentResolutions: [
                {
                  ...draft,
                  outcome: outcomes.length === 1 ? outcomes[0] : "<choose affected outcome>",
                  reason: "",
                },
              ],
            },
            guidance:
              "Inspect the cited observation and delivered image. If they diagnose the original failure as a mistaken test route or expectation, choose its affected outcome, supply the reason, and report reviewer.context as current or fresh only after actual inspection. Empty reasons and unspecified reviewers cannot resolve a failure. Otherwise keep the failure open and repair or rerun it. This candidate does not establish product quality.",
          },
        ];
      }
      return [];
    });
}

/** Diagnose a mistaken assertion without waiving a current check or erasing raw history. */
export function validateExperimentResolutions(
  input: unknown,
  record: ProductRecord,
  subject: string,
  slice: ProductSlice | undefined,
  catalogue: ProductEvidenceCatalogue,
): Result<ExperimentResolution[]> {
  const parsed = experimentResolutionsSchema.safeParse(input ?? []);
  if (!parsed.success)
    return err(
      vispError("ARTIFACT_INVALID", `Invalid experiment resolution: ${parsed.error.message}`),
    );
  const failed = latestCurrentJourneys(record, subject, slice?.id).filter(
    (run) => run.status && run.status !== "completed",
  );
  const current = record.state.captureRuns.flatMap((entry) => {
    const run = productCaptureRunSchema.safeParse(entry);
    return run.success && evidenceApplies(record, subject, run.data) ? [run.data] : [];
  });
  const seen = new Set<string>();
  for (const resolution of parsed.data) {
    const failure = failed.find((run) => run.id === resolution.runId);
    const replacement = current.find((run) => run.id === resolution.replacementRunId);
    const outcome = record.brief.outcomes.find((entry) => entry.id === resolution.outcome);
    const owner = record.brief.slices.find((entry) => entry.id === failure?.task);
    if (
      seen.has(resolution.runId) ||
      !failure ||
      failure.failure?.kind !== "behavior" ||
      !canDiagnoseAssertion(record, failure, replacement) ||
      !outcome ||
      !inOutcomeScope(slice, outcome.id) ||
      !inOutcomeScope(owner, outcome.id)
    )
      return err(
        vispError(
          "EVIDENCE_FAILED",
          "Resolve a current exploratory failure or a revised declared assertion with a passing execution of the same check. Preserve the outcome and original input; current declared checks must be rerun or revised through the brief.",
        ),
      );
    seen.add(resolution.runId);
    if (
      replacement?.version !== 2 ||
      replacement.status !== "completed" ||
      replacement.task !== failure.task ||
      !sameJourneyIntent(failure, replacement) ||
      record.state.captureRuns.findIndex(
        (run) => productCaptureRunSchema.safeParse(run).data?.id === replacement.id,
      ) <=
        record.state.captureRuns.findIndex(
          (run) => productCaptureRunSchema.safeParse(run).data?.id === failure.id,
        ) ||
      failed.some((run) => run.journeyKey === replacement.journeyKey)
    )
      return err(
        vispError(
          "EVIDENCE_FAILED",
          "Resolution requires a later completed replacement journey for the same current product, contract and task",
        ),
      );
    const refs = resolution.evidence.map((id) =>
      catalogue.entries.find((entry) => entry.id === (catalogue.aliases.get(id) ?? id)),
    );
    if (!failedInputReplayed(failure, replacement))
      return err(
        vispError(
          "EVIDENCE_FAILED",
          "The replacement bypasses the failed input path. Execute the original control and input successfully; an alternative input is not counterevidence.",
        ),
      );
    const observed = replacement.operations.some(
      (operation) =>
        operation.kind === "observe" &&
        refs.some((entry) => entry?.id === operation.id && entry.status === "available"),
    );
    const image = replacement.captures.some(
      (capture) =>
        refs.some(
          (entry) =>
            entry?.id === capture.id && entry.status === "available" && entry.kind === "image",
        ) &&
        failure.captures.some(
          (previous) =>
            previous.route === capture.route &&
            previous.viewport.width === capture.viewport.width &&
            previous.viewport.height === capture.viewport.height,
        ),
    );
    if (!observed || !image || refs.some((entry) => entry?.status !== "available"))
      return err(
        vispError(
          "EVIDENCE_FAILED",
          "Cite a successful replacement observation and its delivered image at the failed journey's route and viewport; printed claims or stale/unseen evidence cannot resolve an experiment",
        ),
      );
  }
  return ok(parsed.data);
}

type Journey = ReturnType<typeof productCaptureRunSchema.parse>;

function canDiagnoseAssertion(record: ProductRecord, failure: Journey, replacement?: Journey) {
  return (
    !isDeclaredJourney(record, failure) ||
    (!!replacement && hasExecutedDeclaredRevision(record, failure, replacement))
  );
}

/** An altered test route may recover a failure, but a different control cannot stand in for it. */
function failedInputReplayed(failure: Journey, replacement: Journey): boolean {
  if (failure.failure?.input)
    return (
      replacement.completedInputs?.some(
        (input) => hashValue(input) === hashValue(failure.failure?.input),
      ) ?? false
    );
  const inputKinds = ["pointer", "touch", "keyboard"];
  const failedIndex = failure.operations.findIndex(
    (entry) => entry.id === failure.failure?.operationId,
  );
  const preceding = failure.operations.slice(0, failedIndex < 0 ? undefined : failedIndex + 1);
  const failedOperation = preceding.findLast((entry) => inputKinds.includes(entry.kind));
  if (
    !failedOperation ||
    !/pointer travel|reachable|intercept|control moved/i.test(failure.failure?.message ?? "")
  )
    return true;
  return replacement.operations.some(
    (entry) =>
      entry.kind === failedOperation.kind && entry.description === failedOperation.description,
  );
}

function inOutcomeScope(slice: ProductSlice | undefined, outcome: string): boolean {
  return !slice || slice.outcomes.includes(outcome);
}
