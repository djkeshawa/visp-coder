import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import { browserInputIdentitySchema } from "../../testing/browser-input-identity.js";
import { browserJourneySchema } from "../../testing/browser-journey.js";
import { replaySuggestions } from "../evidence/capture-replay.js";
import {
  currentExactReplay,
  exactReplayIdentity,
  historicalFailureIdentity,
  journeyHistoryGroup,
  legacyFailure,
} from "../evidence/journey-history.js";
import { imageDimensions } from "../evidence/observations/media.js";
import type { ProductReviewImage } from "../evidence/product-review.js";
import type { WorkspaceState } from "../state.js";
import { productCheckSupportsBehavior } from "./check-command.js";
import { reviewCodeSources } from "./code-context.js";
import { captureSchema, type ProductImageAvailability } from "./images.js";
import { hasExecutedDeclaredRevision, isDeclaredJourney } from "./journey-ownership.js";
import {
  latestExecutionsByOwner,
  type ProductAssessment,
  type ProductExecution,
  type ProductSlice,
} from "./model.js";
import { type ProductSource, productSources, type sourceClaims } from "./sources.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";

export interface ProductEvidenceReference {
  readonly id: string;
  readonly kind: "execution" | "image" | "operation" | "control" | "source";
  readonly status: "available" | "failed" | "stale" | "unavailable" | "not-delivered";
  readonly summary: string;
  /** Runner-owned binding; never inferred from the reviewer's text. */
  readonly captureRunId?: string;
  readonly outcomes: readonly string[];
  readonly viewport?: { width: number; height: number };
  readonly measurement?: { json: string; truncated: boolean };
  /** Static/syntax executions remain receipts, but cannot support functional claims. */
  readonly supportsBehavior?: boolean;
}
export interface ProductEvidenceCatalogue {
  readonly entries: readonly ProductEvidenceReference[];
  readonly aliases: ReadonlyMap<string, string>;
  readonly sources: readonly ProductSource[];
  readonly sourceClaims: ReturnType<typeof sourceClaims>;
}

/** Only executed checks and matched observations can substantiate functional behavior. */
export function supportsBehaviorEvidence(entry: ProductEvidenceReference): boolean {
  return (
    (entry.kind === "execution" && entry.supportsBehavior !== false) ||
    (entry.kind === "operation" && entry.supportsBehavior === true)
  );
}

export function evidenceApplies(
  record: ProductRecord,
  subject: string,
  entry: { subjectDigest: string; contractDigest?: string; task?: string; version?: number },
): boolean {
  const owner = record.brief.slices.find((slice) => slice.id === entry.task);
  return (
    entry.subjectDigest === subject &&
    (entry.version !== 2 || !!entry.contractDigest) &&
    (!entry.task || !!owner) &&
    (!entry.contractDigest || entry.contractDigest === productContractDigest(record.brief, owner))
  );
}

function evidenceInSlice(task: string | undefined, selectedSlice?: ProductSlice): boolean {
  return !selectedSlice || !task || task === selectedSlice.id;
}

const operation = z.object({
  id: z.string(),
  kind: z.enum([
    "navigate",
    "measure",
    "pointer",
    "touch",
    "keyboard",
    "capture",
    "observe",
    "scroll",
  ]),
  description: z.string().optional(),
  measurement: z.object({ json: z.string(), truncated: z.boolean() }).optional(),
});
export const productCaptureRunSchema = z.object({
  id: z.string().optional(),
  version: z.union([z.literal(1), z.literal(2)]),
  provenance: z.literal("runner-executed"),
  subjectDigest: z.string(),
  outcomeDigest: z.string().optional(),
  contractDigest: z.string().optional(),
  task: z.string().optional(),
  journeyDigest: z.string().optional(),
  comparisonEnvironment: z.string().optional(),
  journey: browserJourneySchema.optional(),
  journeyKey: z.string().optional(),
  status: z.enum(["completed", "failed", "timed-out", "cancelled"]).optional(),
  completedInputs: z.array(browserInputIdentitySchema).optional(),
  failure: z
    .object({
      kind: z.string(),
      message: z.string(),
      operationId: z.string().optional(),
      input: browserInputIdentitySchema.optional(),
    })
    .optional(),
  captures: z.array(captureSchema),
  operations: z.array(operation),
});

const control = z.object({
  id: z.string(),
  subjectDigest: z.string(),
  contractDigest: z.string(),
  task: z.string().optional(),
  outcomes: z.array(z.string()),
  execution: z.object({ provenance: z.literal("supervisor-executed"), detected: z.boolean() }),
});

/** Derived from existing execution records, never an additional agent-maintained ledger. */
export async function productEvidenceCatalogue(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
  images: readonly ProductReviewImage[],
  availability: readonly ProductImageAvailability[] = [],
  codeSources?: readonly ProductSource[],
  selectedSlice?: ProductSlice,
): Promise<ProductEvidenceCatalogue> {
  const entries: ProductEvidenceReference[] = [];
  const aliases = new Map<string, string>();
  executionReferences(record, subject, entries, aliases, selectedSlice);
  imageReferences(record, subject, images, entries, aliases, availability);
  operationReferences(record, subject, entries, selectedSlice);
  controlReferences(record, subject, entries, selectedSlice);
  const { sources, claims } = await productSources(workspace, record);
  sources.push(...(codeSources ?? (await reviewCodeSources(workspace, record))));
  for (const source of sources)
    entries.push({
      id: source.id,
      kind: "source",
      outcomes: [],
      status: source.available ? "available" : "unavailable",
      summary: `${source.reference}: ${source.sha256}`,
    });
  const ambiguous = ambiguousEvidenceIds(entries);
  for (const [index, entry] of entries.entries())
    if (ambiguous.has(entry.id))
      entries[index] = {
        ...entry,
        status: "unavailable",
        summary: `${entry.summary}; ambiguous evidence ID`,
        supportsBehavior: false,
      };
  return { entries, aliases, sources, sourceClaims: claims };
}

export function ambiguousEvidenceIds(entries: readonly ProductEvidenceReference[]) {
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const entry of entries)
    if (seen.has(entry.id)) ambiguous.add(entry.id);
    else seen.add(entry.id);
  return ambiguous;
}

function executionReferences(
  record: ProductRecord,
  subject: string,
  entries: ProductEvidenceReference[],
  aliases: Map<string, string>,
  selectedSlice?: ProductSlice,
): void {
  const latest = new Map(
    record.state.executions
      .filter(
        (entry) =>
          evidenceApplies(record, subject, entry) && evidenceInSlice(entry.task, selectedSlice),
      )
      .map((entry) => [executionInputKey(entry), entry]),
  );
  const aliasesByCheck = new Map<string, ProductExecution>();
  const applicable = record.state.executions.filter(
    (entry) =>
      evidenceApplies(record, subject, entry) && evidenceInSlice(entry.task, selectedSlice),
  );
  for (const execution of latestExecutionsByOwner(applicable)) {
    const previous = aliasesByCheck.get(execution.check);
    if (
      !previous ||
      executionAliasPriority(execution, selectedSlice) >=
        executionAliasPriority(previous, selectedSlice)
    )
      aliasesByCheck.set(execution.check, execution);
  }
  const runs = new Map(
    record.state.captureRuns.flatMap((candidate) => {
      const parsed = productCaptureRunSchema.safeParse(candidate);
      return parsed.success && parsed.data.id ? [[parsed.data.id, parsed.data] as const] : [];
    }),
  );
  for (const execution of record.state.executions)
    entries.push(executionReference(record, subject, execution, latest, runs, selectedSlice));
  appendCheckAliases(record, aliasesByCheck, entries, aliases);
}

function executionAliasPriority(execution: ProductExecution, slice?: ProductSlice): number {
  const status =
    execution.status === "failed" ? 4 : execution.status === "environment-failed" ? 2 : 0;
  return status + Number(slice !== undefined && execution.task === slice.id);
}

function executionReference(
  record: ProductRecord,
  subject: string,
  execution: ProductExecution,
  latest: ReadonlyMap<string, ProductExecution>,
  runs: ReadonlyMap<string, z.infer<typeof productCaptureRunSchema>>,
  selectedSlice?: ProductSlice,
): ProductEvidenceReference {
  const current = evidenceApplies(record, subject, execution);
  const supersededByFailure = latest.get(executionInputKey(execution))?.status !== "passed";
  const inScope = evidenceInSlice(execution.task, selectedSlice);
  const check = record.brief.checks.find((entry) => entry.id === execution.check);
  const summary = executionSummary(execution, runs.get(execution.captureRunId ?? ""));
  return {
    id: execution.id,
    captureRunId: execution.captureRunId,
    kind: "execution",
    outcomes: check?.outcomes ?? [],
    status: inScope
      ? executionReferenceStatus(current, execution.status, supersededByFailure)
      : "unavailable",
    summary: inScope
      ? summary
      : `${summary}; belongs to task ${execution.task ?? "none"}, not ${selectedSlice?.id}`,
    supportsBehavior: check ? productCheckSupportsBehavior(check) : false,
  };
}

function appendCheckAliases(
  record: ProductRecord,
  latestByCheck: ReadonlyMap<string, ProductExecution>,
  entries: ProductEvidenceReference[],
  aliases: Map<string, string>,
) {
  for (const [check, execution] of latestByCheck) aliases.set(check, execution.id);
  for (const check of record.brief.checks) {
    if (!latestByCheck.has(check.id))
      entries.push({
        id: check.id,
        kind: "execution",
        status: "unavailable",
        outcomes: check.outcomes,
        summary: `${check.id}: no current execution`,
      });
  }
}

function executionInputKey(entry: ProductRecord["state"]["executions"][number]) {
  return JSON.stringify([entry.check, entry.task, entry.contractDigest, entry.command]);
}

/** Summarize only a bound runner record; never parse agent-printed output as browser evidence. */
export function executionSummary(
  execution: ProductRecord["state"]["executions"][number],
  run?: z.infer<typeof productCaptureRunSchema>,
) {
  const prefix = `${execution.check}: ${execution.command}`;
  if (
    !run?.id ||
    !run.status ||
    execution.captureRunId !== run.id ||
    execution.subjectDigest !== run.subjectDigest ||
    execution.contractDigest !== run.contractDigest ||
    execution.task !== run.task ||
    execution.status !== (run.status === "completed" ? "passed" : "failed") ||
    (run.status !== "completed" && !run.failure)
  )
    return `${prefix}\n${execution.output}`;
  return `${prefix}\nRunner journey ${run.id}: ${run.status}; ${run.operations.length} recorded operations. Images and observations are supplied separately.${run.failure ? `\n${run.failure.kind}: ${run.failure.message}${run.failure.operationId ? ` (operation ${run.failure.operationId})` : ""}` : ""}`;
}

function executionReferenceStatus(
  current: boolean,
  status: string,
  supersededByFailure: boolean,
): ProductEvidenceReference["status"] {
  if (!current) return "stale";
  if (status === "environment-failed") return "unavailable";
  return status === "failed" || supersededByFailure ? "failed" : "available";
}

function imageReferences(
  record: ProductRecord,
  subject: string,
  images: readonly ProductReviewImage[],
  entries: ProductEvidenceReference[],
  aliases: Map<string, string>,
  availability: readonly ProductImageAvailability[] = [],
): void {
  const inspected = new Map(availability.map((entry) => [entry.id, entry]));
  const knownImages = new Map(images.map((image) => [image.id, image]));
  const captures = [
    ...record.state.captures,
    ...record.state.reviews.flatMap((review) => review.captures),
    ...images,
  ];
  const seen = new Set<string>();
  for (const candidate of captures) {
    const parsed = captureSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const capture = parsed.data;
    seen.add(capture.id);
    entries.push({
      id: capture.id,
      kind: "image",
      outcomes: [],
      viewport: observedViewport(record, subject, knownImages.get(capture.id)),
      status:
        capture.subjectDigest !== subject
          ? "stale"
          : knownImages.has(capture.id)
            ? "available"
            : inspected.get(capture.id)?.status === "not-delivered"
              ? "not-delivered"
              : "unavailable",
      summary: `${capture.route}; ${capture.viewport.width}×${capture.viewport.height}; ${capture.provenance}${inspected.get(capture.id)?.status === "not-delivered" ? "; intact image not delivered in this group; select its image group for review" : ""}`,
    });
    aliases.set(capture.path, capture.id);
  }
}

function observedViewport(record: ProductRecord, subject: string, image?: ProductReviewImage) {
  if (image?.provenance !== "runner-captured") return undefined;
  const dimensions = imageDimensions(Buffer.from(image.data, "base64"));
  if (dimensions?.width !== image.viewport.width || dimensions.height !== image.viewport.height)
    return undefined;
  const recorded = record.state.captureRuns.some((candidate) => {
    const run = productCaptureRunSchema.safeParse(candidate);
    return (
      run.success &&
      evidenceApplies(record, subject, run.data) &&
      (run.data.version === 1 || run.data.status === "completed") &&
      run.data.captures.some(
        (capture) =>
          capture.provenance === "runner-captured" &&
          capture.id === image.id &&
          capture.path === image.path &&
          capture.sha256 === image.sha256,
      )
    );
  });
  return recorded ? image.viewport : undefined;
}

function operationReferences(
  record: ProductRecord,
  subject: string,
  entries: ProductEvidenceReference[],
  selectedSlice?: ProductSlice,
): void {
  for (const candidate of record.state.captureRuns) {
    const parsed = productCaptureRunSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const run = parsed.data;
    const current =
      evidenceApplies(record, subject, run) && evidenceInSlice(run.task, selectedSlice);
    for (const observed of run.operations) {
      const status = !current ? "stale" : observationStatus(observed);
      entries.push({
        id: observed.id,
        kind: "operation",
        outcomes: run.task
          ? (record.brief.slices.find((slice) => slice.id === run.task)?.outcomes ?? [])
          : [],
        status,
        summary: `${observed.kind}: ${observed.description ?? "Observed browser operation"}`,
        measurement: observed.measurement,
        supportsBehavior: status === "available" && ["observe", "scroll"].includes(observed.kind),
      });
    }
  }
}

function controlReferences(
  record: ProductRecord,
  subject: string,
  entries: ProductEvidenceReference[],
  selectedSlice?: ProductSlice,
): void {
  for (const candidate of record.state.controls) {
    const parsed = control.safeParse(candidate);
    if (!parsed.success) continue;
    entries.push({
      id: parsed.data.id,
      kind: "control",
      outcomes: parsed.data.outcomes,
      status:
        !evidenceInSlice(parsed.data.task, selectedSlice) ||
        !evidenceApplies(record, subject, parsed.data)
          ? "stale"
          : parsed.data.execution.detected
            ? "available"
            : "failed",
      summary: "Supervisor-executed verifier sensitivity; not proof of product quality",
    });
  }
}

function observationStatus(
  observed: z.infer<typeof operation>,
): ProductEvidenceReference["status"] {
  if (observed.kind !== "observe" && observed.kind !== "scroll") return "available";
  if (!observed.measurement || observed.measurement.truncated) return "unavailable";
  try {
    const matched = JSON.parse(observed.measurement.json).matched;
    return matched === true ? "available" : matched === false ? "failed" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function resolveAssessmentEvidence(
  assessment: ProductAssessment,
  catalogue: ProductEvidenceCatalogue,
): Result<ProductAssessment> {
  const known = new Map(catalogue.entries.map((entry) => [entry.id, entry]));
  const ambiguous = ambiguousEvidenceIds(catalogue.entries);
  const resolve = (references: readonly string[]): Result<string[]> => {
    const resolved: string[] = [];
    for (const reference of references) {
      const id = catalogue.aliases.get(reference) ?? reference;
      if (ambiguous.has(id))
        return err(vispError("EVIDENCE_FAILED", `Ambiguous evidence reference: ${reference}`));
      if (!known.has(id))
        return err(vispError("EVIDENCE_FAILED", `Unknown evidence reference: ${reference}`));
      resolved.push(id);
    }
    return ok([...new Set(resolved)]);
  };
  const evidence = resolve(assessment.evidence);
  if (!evidence.ok) return evidence;
  const expectations = [];
  for (const expectation of assessment.expectations) {
    const refs = resolve(expectation.evidence ?? assessment.evidence);
    if (!refs.ok) return refs;
    expectations.push({ ...expectation, evidence: refs.value });
  }
  return ok({
    ...assessment,
    evidence: [...new Set([...evidence.value, ...expectations.flatMap((entry) => entry.evidence)])],
    expectations,
  });
}

export function evidenceSupportGaps(
  references: readonly string[],
  catalogue: ProductEvidenceCatalogue,
  outcome?: string,
  requiresBehavior = false,
): string[] {
  const known = new Map(catalogue.entries.map((entry) => [entry.id, entry]));
  const ambiguous = ambiguousEvidenceIds(catalogue.entries);
  const ids = references.map((id) => catalogue.aliases.get(id) ?? id);
  const entries = ids.map((id) => (ambiguous.has(id) ? undefined : known.get(id)));
  const gaps = entries.flatMap((entry, index) =>
    ambiguous.has(ids[index] ?? "")
      ? [`${references[index]}: ambiguous evidence ID`]
      : !entry
        ? [`Unknown evidence reference: ${references[index]}`]
        : entry.status === "available"
          ? []
          : [
              entry.status === "not-delivered"
                ? `${entry.id}: intact image not delivered; select its image group with review --group before judging it`
                : `${entry.id}: evidence ${entry.status}`,
            ],
  );
  for (const entry of entries)
    if (outcome && entry?.outcomes.length && !entry.outcomes.includes(outcome))
      gaps.push(`${entry.id}: declared evidence mapping does not include ${outcome}`);
  if (
    !entries.some(
      (entry) =>
        entry?.status === "available" &&
        entry.kind !== "source" &&
        (!requiresBehavior || supportsBehaviorEvidence(entry)),
    )
  )
    gaps.push("No current execution or observation supports this judgment");
  return gaps;
}

export function currentJourneyFailures(
  record: ProductRecord,
  subject: string,
  task?: string,
): string[] {
  return [
    ...currentFailedJourneys(record, subject, task).map(
      (run) => `Browser ${run.status}: ${run.failure?.message ?? "Journey did not complete"}`,
    ),
    ...pendingJourneyReplays(record, subject, task).map(
      (run) =>
        `Replay required for ${run.id}: ${run.failure?.message}. Run visp capture --feature ${record.brief.feature}${run.task ? ` --task ${run.task}` : ""} --replay ${run.id}; keep the original interactions and assertions.`,
    ),
  ];
}

/** A source edit makes old evidence stale; it does not demonstrate that a known defect was repaired. */
export function pendingJourneyReplays(record: ProductRecord, subject: string, task?: string) {
  const failed = new Map<string, z.infer<typeof productCaptureRunSchema>>();
  const current = latestCurrentJourneys(record, subject, task);
  const unresolved = new Set(currentFailedJourneys(record, subject, task).map((run) => run.id));
  for (const candidate of record.state.captureRuns) {
    const parsed = productCaptureRunSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const run = parsed.data;
    if (
      !run.id ||
      !run.journey ||
      run.failure?.kind !== "behavior" ||
      (task && run.task && run.task !== task) ||
      (run.task && !record.brief.slices.some((slice) => slice.id === run.task))
    )
      continue;
    const identity = historicalFailureIdentity(run);
    if (identity) failed.set(identity, run);
  }
  return [...failed.values()].filter(
    (failure) =>
      !current.some(
        (run) =>
          (legacyFailure(failure)
            ? currentExactReplay(run) && exactReplayIdentity(run) === exactReplayIdentity(failure)
            : run.journeyKey === failure.journeyKey) &&
          (run.status === "completed" || !unresolved.has(run.id)),
      ) &&
      (legacyFailure(failure) || !evidenceApplies(record, subject, failure)),
  );
}

/** Drop incidental container text only when the recorded assertion did not test text. */
function focusedTerminalMeasurement(measurement: { json: string; truncated: boolean } | undefined) {
  if (!measurement) return undefined;
  try {
    const value = JSON.parse(measurement.json);
    if (
      value?.expected?.kind === "wait-for" &&
      value.expected.text === undefined &&
      value.actual &&
      typeof value.actual.text === "string"
    ) {
      const { text: _text, ...actual } = value.actual;
      return {
        json: JSON.stringify({ ...value, actual, omittedFields: ["actual.text"] }),
        truncated: true,
      };
    }
  } catch {
    /* Unknown diagnostics retain their original bytes. */
  }
  return measurement;
}

/** Bounded repair context from the same applicable failures used by completion gates. */
export function currentJourneyFeedback(record: ProductRecord, subject: string, task?: string) {
  const failures = currentFailedJourneys(record, subject, task);
  return {
    replay: replaySuggestions(record, subject, task),
    runs: failures
      .slice(-3)
      .reverse()
      .map((run) => {
        const observed = run.failure?.operationId
          ? run.operations.find((entry) => entry.id === run.failure?.operationId)
          : run.operations.findLast((entry) => entry.kind === "observe");
        const measurement = focusedTerminalMeasurement(observed?.measurement);
        return {
          runId: run.id,
          status: run.status,
          input: run.failure?.input,
          recovery: isDeclaredJourney(record, run)
            ? "Rerun or correct the declared journey in the brief; preserve its outcome. After that same check passes, review --prepare can supply counterevidence to diagnose the obsolete assertion without changing intent."
            : `Keep the original input, route and viewport when checking a suspected test-route error. Scroll to an off-screen control if appropriate, execute that control and observe the actual result. Then visp review --feature ${record.brief.feature}${task ? ` --task ${task}` : ""} --prepare can offer current counterevidence for your diagnosis; it does not clear failures automatically.`,
          message: (run.failure?.message ?? "Journey did not complete").slice(0, 1000),
          failureOperationId: run.failure?.operationId ?? observed?.id,
          ...(measurement
            ? {
                terminalMeasurement: {
                  json: measurement.json.slice(0, 8000),
                  truncated: measurement.truncated || measurement.json.length > 8000,
                },
              }
            : {}),
          captureIds: run.captures.slice(-6).map((capture) => capture.id),
        };
      }),
    omitted: Math.max(0, failures.length - 3),
  };
}

function retainedJourneyFailure(
  record: ProductRecord,
  run: z.infer<typeof productCaptureRunSchema>,
) {
  if (run.failure?.kind !== "behavior" || run.status === "completed") return false;
  if (evidenceApplies(record, run.subjectDigest, run)) return true;
  return (
    !!run.outcomeDigest &&
    run.outcomeDigest === record.state.outcomeDigest &&
    (!run.task || record.brief.slices.some((slice) => slice.id === run.task))
  );
}

export function latestCurrentJourneys(record: ProductRecord, subject: string, task?: string) {
  const latest = new Map<string, z.infer<typeof productCaptureRunSchema>>();
  const legacyReplays = new Set(
    record.state.captureRuns.flatMap((candidate) => {
      const parsed = productCaptureRunSchema.safeParse(candidate);
      return parsed.success && legacyFailure(parsed.data) ? [exactReplayIdentity(parsed.data)] : [];
    }),
  );
  for (const candidate of record.state.captureRuns) {
    const run = productCaptureRunSchema.safeParse(candidate);
    if (
      !run.success ||
      (!evidenceApplies(record, subject, run.data) && !retainedJourneyFailure(record, run.data)) ||
      (task && run.data.task && run.data.task !== task)
    )
      continue;
    const identity = journeyHistoryGroup(run.data, legacyReplays);
    const key = JSON.stringify([
      run.data.task,
      run.data.outcomeDigest ?? run.data.contractDigest,
      identity,
    ]);
    latest.delete(key);
    latest.set(key, run.data);
  }
  return [...latest.values()];
}

export function currentFailedJourneys(record: ProductRecord, subject: string, task?: string) {
  const runs = latestCurrentJourneys(record, subject, task);
  const completed = new Map(
    record.state.captureRuns.flatMap((candidate) => {
      const parsed = productCaptureRunSchema.safeParse(candidate);
      return parsed.success &&
        parsed.data.status === "completed" &&
        evidenceApplies(record, subject, parsed.data)
        ? [[parsed.data.id, parsed.data] as const]
        : [];
    }),
  );
  const resolutions = record.state.reviews
    .filter((review) => evidenceApplies(record, subject, review))
    .flatMap((review) => review.experimentResolutions ?? []);
  return runs.filter(
    (run) =>
      run.status &&
      run.status !== "completed" &&
      !resolutions.some(
        (resolution) =>
          resolution.runId === run.id &&
          runs.some(
            (replacement) =>
              (replacement.id === resolution.replacementRunId ||
                (replacement.journeyKey !== undefined &&
                  replacement.journeyKey ===
                    completed.get(resolution.replacementRunId)?.journeyKey)) &&
              replacement.status === "completed" &&
              replacement.task === run.task &&
              (!isDeclaredJourney(record, run) ||
                hasExecutedDeclaredRevision(record, run, replacement)) &&
              sameJourneyIntent(run, replacement),
          ),
      ),
  );
}

export function sameJourneyIntent(
  previous: { task?: string; outcomeDigest?: string; contractDigest?: string },
  current: { task?: string; outcomeDigest?: string; contractDigest?: string },
) {
  return (
    previous.task === current.task &&
    (previous.outcomeDigest
      ? previous.outcomeDigest === current.outcomeDigest
      : previous.contractDigest === current.contractDigest)
  );
}
