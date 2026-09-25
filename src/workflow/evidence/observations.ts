import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { vispError } from "../../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
  withStateMutation,
} from "../../core/file-transaction.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { isPortableAbsolute, toPosix } from "../../core/paths.js";
import { err, ok, type Result } from "../../core/result.js";
import { now } from "../artifacts/common.js";
import type { CriterionCheck } from "../artifacts/evidence.js";
import type { QualityRequirement, Requirement, Spec } from "../artifacts/feature.js";
import {
  type ObservationAttachment,
  type ObservationCapture,
  type ObservationEnvironment,
  type ObservationReceipt,
  type ObservationView,
  type ObservationViewport,
  observationResultSchema,
  observationSourceSchema,
} from "../artifacts/observations.js";
import { findTask } from "../artifacts/tasks.js";
import { stableContextHash } from "../stages/context/digest.js";
import { currentContextSourceHash } from "../stages/context/freshness.js";
import type { WorkspaceState } from "../state.js";
import {
  criterionContractHash,
  type OwnedCriterion,
  ownedCriterionView,
  semanticObservationHash,
  staleReasonsFor,
} from "./observations/freshness.js";
import { observationReproductionState } from "./observations/identity.js";
import {
  digestBytes,
  imageDimensions,
  isImageArtifact,
  validateBrowserAttachmentDimensions,
  validateVisualContext,
} from "./observations/media.js";

export interface RecordObservationOptions {
  readonly feature: string;
  readonly task: string;
  readonly criterion: string;
  readonly source: "browser" | "manual";
  readonly result: "satisfied" | "failed" | "unclear";
  readonly note: string;
  readonly artifacts?: readonly string[];
  readonly viewport?: ObservationViewport;
  readonly capture?: ObservationCapture;
  readonly route?: string;
  readonly steps?: readonly string[];
  readonly environment?: ObservationEnvironment;
}

export interface RecordObservationRuntime {
  /** Fault-injection seam used to prove attachment and receipt rollback. */
  readonly afterMutation?: (applied: number) => void | Promise<void>;
  readonly leavePreparedOnError?: boolean;
}

interface NormalizedObservation {
  readonly source: "browser" | "manual";
  readonly result: "satisfied" | "failed" | "unclear";
  readonly note: string;
  readonly route?: string;
  readonly steps: readonly string[];
  readonly environment?: ObservationEnvironment;
}

interface ObservationContext {
  readonly task: import("../artifacts/tasks.js").Task;
  readonly owned: OwnedCriterion;
  readonly specHash: string;
  readonly contextManifestHash: string;
  readonly subjectHash: string;
  readonly sourceHash: string;
  readonly existing?: import("../artifacts/observations.js").ObservationLog;
}

interface AttachmentSource {
  readonly sourcePath: string;
  readonly bytes: Buffer;
  readonly digest: string;
  readonly dimensions?: { readonly width: number; readonly height: number };
}

export async function recordObservation(
  state: WorkspaceState,
  options: RecordObservationOptions,
  runtime: RecordObservationRuntime = {},
): Promise<Result<ObservationReceipt>> {
  return withStateMutation(state.paths.root, () =>
    recordObservationLocked(state, options, runtime),
  );
}

async function recordObservationLocked(
  state: WorkspaceState,
  options: RecordObservationOptions,
  runtime: RecordObservationRuntime,
): Promise<Result<ObservationReceipt>> {
  const normalized = normalizeObservation(options);
  if (!normalized.ok) return normalized;

  const context = await loadObservationContext(state, options);
  if (!context.ok) return context;

  const createdAt = now();
  const id = `OBS-${sha256(randomUUID()).slice(0, 12)}`;
  const attachmentPlan = await planAttachments(state, options.feature, options);
  if (!attachmentPlan.ok) return attachmentPlan;

  const receipt = buildObservationReceipt(
    options,
    normalized.value,
    context.value,
    attachmentPlan.value.attachments,
    id,
    createdAt,
  );
  const duplicate = await findIntactDuplicate(state, context.value.existing, receipt);
  if (duplicate) return ok(duplicate);

  const log = {
    kind: "observations",
    createdAt: context.value.existing?.createdAt ?? createdAt,
    feature: options.feature,
    task: context.value.task.id,
    observations: replaceObservationState(context.value.existing?.observations ?? [], receipt),
  } as const;
  const logMutation = await planObservationLogMutation(state, log, context.value.existing);
  if (!logMutation.ok) return logMutation;
  const written = await applyFileTransaction(
    state.paths.root,
    "observation-ingest",
    [...attachmentPlan.value.mutations, logMutation.value],
    runtime,
  );
  return written.ok ? ok(receipt) : written;
}

/** Keep one active receipt for one criterion under one reproducible state. */
function replaceObservationState(
  existing: readonly ObservationReceipt[],
  receipt: ObservationReceipt,
): ObservationReceipt[] {
  return [...existing.filter((candidate) => !sameObservationState(candidate, receipt)), receipt];
}

function sameObservationState(left: ObservationReceipt, right: ObservationReceipt): boolean {
  return (
    left.identityVersion === right.identityVersion &&
    left.criterion === right.criterion &&
    left.source === right.source &&
    left.specHash === right.specHash &&
    left.contextManifestHash === right.contextManifestHash &&
    reproductionSignature(left) === reproductionSignature(right)
  );
}

function normalizeObservation(options: RecordObservationOptions): Result<NormalizedObservation> {
  const source = observationSourceSchema.safeParse(options.source);
  const result = observationResultSchema.safeParse(options.result);
  const note = options.note.trim();
  if (!source.success || !result.success || note.length === 0 || note.length > 4_000) {
    return err(vispError("CONFIG_INVALID", "Observation source, result, or note is invalid"));
  }
  const visualContext = validateVisualContext(options);
  if (visualContext) return err(vispError("CONFIG_INVALID", visualContext));

  const route = options.route?.trim();
  const environment = normalizeEnvironment(options.environment);
  return ok({
    source: source.data,
    result: result.data,
    note,
    ...(route ? { route } : {}),
    steps: (options.steps ?? []).filter((step) => step.trim().length > 0),
    ...(environment ? { environment } : {}),
  });
}

async function loadObservationContext(
  state: WorkspaceState,
  options: RecordObservationOptions,
): Promise<Result<ObservationContext>> {
  const [graph, spec, manifest, pack, existing] = await Promise.all([
    state.store.readTasks(options.feature),
    state.store.readSpec(options.feature),
    state.store.readContextManifest(options.feature, options.task),
    state.store.readContextPack(options.feature, options.task),
    state.store.readObservations(options.feature, options.task),
  ]);
  if (!graph.ok) return graph;
  const task = findTask(graph.value, options.task);
  if (!task) {
    return err(vispError("TASK_NOT_FOUND", `Task ${options.task} does not exist`));
  }

  if (!spec.ok) return spec;
  const owned = ownedCriterion(
    [...spec.value.requirements, ...spec.value.qualityRequirements],
    [...task.requirements, ...task.qualityRequirements],
    options.criterion,
  );
  if (!owned.ok) return owned;

  if (!manifest.ok) return manifest;
  if (!manifest.value) {
    return err(
      vispError("EVIDENCE_MISSING", `No compiled context exists for ${task.id}`, {
        recovery: `visp context ${task.id}`,
      }),
    );
  }
  if (!pack.ok) return pack;
  if (!pack.value) {
    return err(
      vispError("EVIDENCE_MISSING", `No compiled context pack exists for ${task.id}`, {
        recovery: `visp context ${task.id}`,
      }),
    );
  }
  const contextHash = stableContextHash(pack.value, manifest.value.graphSnapshotId);
  if (manifest.value.contextHash !== contextHash) {
    return err(
      vispError(
        "STAGE_BLOCKED",
        `Context for ${task.id} does not use the current stable evidence digest`,
        {
          recovery: `visp context ${task.id}`,
          details: {
            recordedContextHash: manifest.value.contextHash,
            stableContextHash: contextHash,
          },
        },
      ),
    );
  }
  const sourceHash = await currentContextSourceHash(state, pack.value);
  if (!sourceHash.ok) return sourceHash;
  if (!existing.ok) return existing;

  return ok({
    task,
    owned: owned.value,
    specHash: criterionContractHash(owned.value),
    contextManifestHash: contextHash,
    subjectHash: semanticObservationHash(
      owned.value,
      contextHash,
      observationReproductionState(options),
      sourceHash.value,
    ),
    sourceHash: sourceHash.value,
    ...(existing.value ? { existing: existing.value } : {}),
  });
}

function buildObservationReceipt(
  options: RecordObservationOptions,
  normalized: NormalizedObservation,
  context: ObservationContext,
  attachments: readonly ObservationAttachment[],
  id: string,
  createdAt: string,
): ObservationReceipt {
  return {
    kind: "observation",
    identityVersion: 2,
    createdAt,
    id,
    feature: options.feature,
    task: context.task.id,
    requirement: context.owned.requirement,
    criterion: context.owned.criterion.id,
    criterionStatement: context.owned.criterion.statement,
    source: normalized.source,
    result: normalized.result,
    note: normalized.note,
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.source === "browser" ? { capture: options.capture ?? "viewport" } : {}),
    ...(normalized.route ? { route: normalized.route } : {}),
    steps: [...normalized.steps],
    ...(normalized.environment ? { environment: normalized.environment } : {}),
    specHash: context.specHash,
    contextManifestHash: context.contextManifestHash,
    subjectHash: context.subjectHash,
    sourceHash: context.sourceHash,
    attachments: [...attachments],
  };
}

async function findIntactDuplicate(
  state: WorkspaceState,
  existing: ObservationContext["existing"],
  receipt: ObservationReceipt,
): Promise<ObservationReceipt | undefined> {
  const contentHash = observationContentHash(receipt);
  for (const candidate of existing?.observations ?? []) {
    if (observationContentHash(candidate) !== contentHash) continue;
    if ((await attachmentStaleReasons(state, candidate)).length === 0) return candidate;
  }
  return undefined;
}

/** Reads receipts with freshness computed against the artifacts on disk now. */
export async function readObservationViews(
  state: WorkspaceState,
  feature: string,
  task?: string,
): Promise<Result<ObservationView[]>> {
  const spec = await state.store.readSpecIfExists(feature);
  if (!spec.ok) return spec;
  const logs = task
    ? await readOneLog(state, feature, task)
    : await state.store.readAllObservations(feature);
  if (!logs.ok) return logs;

  const views = await viewsForLogs(state, feature, spec.value, logs.value);
  if (!views.ok) return views;

  return ok(
    views.value.sort(
      (left, right) =>
        left.task.localeCompare(right.task) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    ),
  );
}

async function viewsForLogs(
  state: WorkspaceState,
  feature: string,
  spec: Spec | undefined,
  logs: readonly import("../artifacts/observations.js").ObservationLog[],
): Promise<Result<ObservationView[]>> {
  const views: ObservationView[] = [];
  for (const log of logs) {
    const manifest = await state.store.readContextManifest(feature, log.task);
    if (!manifest.ok) return manifest;
    const pack = log.observations.some((receipt) => receipt.subjectHash)
      ? await state.store.readContextPack(feature, log.task)
      : ok(undefined);
    if (!pack.ok) return pack;
    const currentSourceHash =
      pack.value && log.observations.some((receipt) => receipt.sourceHash)
        ? await currentContextSourceHash(state, pack.value)
        : ok(undefined);
    if (!currentSourceHash.ok) return currentSourceHash;
    for (const receipt of log.observations) {
      const staleReasons = [
        ...staleReasonsFor(receipt, spec, manifest.value, pack.value, currentSourceHash.value),
        ...(await attachmentStaleReasons(state, receipt)),
      ];
      views.push({ ...receipt, stale: staleReasons.length > 0, staleReasons });
    }
  }
  return ok(markConflictingAttachmentReuse(views));
}

function markConflictingAttachmentReuse(views: readonly ObservationView[]): ObservationView[] {
  const contexts = new Map<string, Set<string>>();
  for (const view of views) {
    if (view.source !== "browser") continue;
    const signature = reproductionSignature(view);
    for (const attachment of view.attachments) {
      // Legacy state normalization lost case. Historical v1 receipts must not
      // invalidate a newly captured v2 state just because the pixels match.
      const key = `${view.identityVersion ?? 1}:${attachment.sha256}`;
      const found = contexts.get(key) ?? new Set<string>();
      found.add(signature);
      contexts.set(key, found);
    }
  }
  const conflicting = new Set(
    [...contexts].flatMap(([digest, signatures]) => (signatures.size > 1 ? [digest] : [])),
  );
  return views.map((view) => {
    const reused = view.attachments.some((attachment) =>
      conflicting.has(`${view.identityVersion ?? 1}:${attachment.sha256}`),
    );
    if (!reused) return view;
    const staleReasons = [
      ...view.staleReasons,
      "attachment reused across different reproduction steps",
    ];
    return { ...view, stale: true, staleReasons };
  });
}

function reproductionSignature(receipt: ObservationReceipt): string {
  return hashValue({
    version: receipt.identityVersion ?? 1,
    state: observationReproductionState(receipt),
  });
}

export { observationReproductionState } from "./observations/identity.js";

function normalizeEnvironment(
  environment: ObservationEnvironment | undefined,
): ObservationEnvironment | undefined {
  if (!environment) return undefined;
  const browserEngine = environment.browserEngine?.trim();
  const platform = environment.platform?.trim();
  if (!browserEngine && !platform) return undefined;
  return {
    ...(browserEngine ? { browserEngine } : {}),
    ...(platform ? { platform } : {}),
  };
}

/** Adds advisory context only; it deliberately cannot alter an outcome. */
export function decorateUncheckedCriteria(
  checks: readonly CriterionCheck[],
  observations: readonly ObservationView[],
): CriterionCheck[] {
  const fresh = observations.filter((observation) => !observation.stale);
  return checks.map((check) => {
    if (check.outcome !== "unchecked") return check;
    const matching = fresh.filter((observation) => observation.criterion === check.criterion);
    if (matching.length === 0) return check;

    const advice = matching
      .map(
        (observation) =>
          `Advisory ${observation.source} observation ${observation.result}: ` +
          `${oneLine(observation.note)}` +
          `${observation.viewport ? ` [${observation.viewport.width}x${observation.viewport.height} ${observation.capture ?? "viewport"}]` : ""}` +
          ` (recorded ${observation.createdAt}; does not verify the criterion)`,
      )
      .join(" | ");
    return { ...check, detail: [check.detail, advice].filter(Boolean).join("; ") };
  });
}

function ownedCriterion(
  requirements: readonly (Requirement | QualityRequirement)[],
  ownedRequirements: readonly string[],
  criterionId: string,
): Result<OwnedCriterion> {
  const owned = new Set(ownedRequirements);
  const matches = requirements
    .filter((requirement) => owned.has(requirement.id))
    .flatMap((requirement) =>
      requirement.criteria
        .filter((criterion) => criterion.id === criterionId)
        .map((criterion) => ownedCriterionView(requirement, criterion)),
    );

  if (matches.length === 1) return ok(matches[0] as OwnedCriterion);
  if (matches.length > 1) {
    return err(
      vispError(
        "ARTIFACT_INVALID",
        `${criterionId} is ambiguous inside ${ownedRequirements.join(", ")}`,
      ),
    );
  }
  return err(
    vispError(
      "EVIDENCE_MISSING",
      `Task does not own criterion ${criterionId}; it must belong to one of ${ownedRequirements.join(", ") || "the task's declared requirements"}`,
    ),
  );
}

async function readOneLog(
  state: WorkspaceState,
  feature: string,
  task: string,
): Promise<Result<import("../artifacts/observations.js").ObservationLog[]>> {
  const log = await state.store.readObservations(feature, task);
  if (!log.ok) return log;
  return ok(log.value ? [log.value] : []);
}

interface AttachmentPlan {
  readonly attachments: ObservationAttachment[];
  readonly mutations: FileMutation[];
}

async function planAttachments(
  state: WorkspaceState,
  feature: string,
  options: RecordObservationOptions,
): Promise<Result<AttachmentPlan>> {
  const requested = options.artifacts ?? [];
  if (requested.length === 0) return ok({ attachments: [], mutations: [] });

  const sources = await readAttachmentSources(state, requested);
  if (!sources.ok) return sources;
  const dimensionIssue = validateBrowserAttachmentDimensions(options, sources.value);
  if (dimensionIssue) return err(vispError("CONFIG_INVALID", dimensionIssue));
  return contentAddressedAttachmentPlan(state, feature, sources.value);
}

async function readAttachmentSources(
  state: WorkspaceState,
  requested: readonly string[],
): Promise<Result<AttachmentSource[]>> {
  const sources: AttachmentSource[] = [];
  const seen = new Set<string>();
  for (const input of requested) {
    const source = observationAttachmentPath(state, input);
    if (!source.ok) return source;
    const metadata = await state.files.metadata(source.value);
    if (!metadata.ok) return metadata;
    if (metadata.value?.type !== "file") {
      return err(vispError("IO_ERROR", `Observation artifact is not a file: ${input}`));
    }
    const bytes = await state.files.readBytes(source.value);
    if (!bytes.ok) return bytes;
    const attachment = attachmentSource(source.value, state.paths.root, Buffer.from(bytes.value));
    if (!attachment.ok) return attachment;
    if (seen.has(attachment.value.digest)) continue;
    seen.add(attachment.value.digest);
    sources.push(attachment.value);
  }
  return ok(sources);
}

/** Observation inputs are project-relative by contract, not ambient filesystem paths. */
function observationAttachmentPath(state: WorkspaceState, input: string): Result<string> {
  if (input.length === 0 || isPortableAbsolute(input)) {
    return err(
      vispError("ARTIFACT_INVALID", `Observation artifact path must be project-relative: ${input}`),
    );
  }
  if (input.replace(/\\/g, "/").split("/").includes("..")) {
    return err(
      vispError(
        "ARTIFACT_INVALID",
        `Observation artifact path contains parent traversal: ${input}`,
      ),
    );
  }
  try {
    return ok(state.paths.absolute(input));
  } catch {
    return err(vispError("ARTIFACT_INVALID", `Invalid observation artifact path: ${input}`));
  }
}

function attachmentSource(
  source: string,
  project: string,
  bytes: Buffer,
): Result<AttachmentSource> {
  const sourcePath = toPosix(relative(project, source));
  const dimensions = imageDimensions(bytes);
  if (isImageArtifact(sourcePath) && !dimensions) {
    return err(
      vispError("CONFIG_INVALID", `Browser image has no readable dimensions: ${sourcePath}`),
    );
  }
  return ok({
    sourcePath,
    bytes,
    digest: digestBytes(bytes),
    ...(dimensions ? { dimensions } : {}),
  });
}

async function contentAddressedAttachmentPlan(
  state: WorkspaceState,
  feature: string,
  sources: readonly AttachmentSource[],
): Promise<Result<AttachmentPlan>> {
  const attachments: ObservationAttachment[] = [];
  const mutations: FileMutation[] = [];

  for (const source of sources) {
    const destination = state.paths.observationAttachmentBlob(feature, source.digest);
    const existing = await readStoredAttachment(state, destination);
    if (!existing.ok) return existing;
    if (existing.value !== undefined && existing.value !== source.digest) {
      return err(
        vispError(
          "IO_ERROR",
          `The content-addressed attachment at ${destination} does not match its digest`,
        ),
      );
    }
    if (existing.value === undefined) {
      mutations.push({
        kind: "write",
        path: destination,
        content: source.bytes,
        mode: 0o644,
        expectedBefore: filePrecondition(undefined),
      });
    }
    const storedPath = state.paths.relative(destination);
    if (!storedPath) {
      return err(
        vispError("INTERNAL", `Observation destination escaped the project: ${destination}`),
      );
    }
    attachments.push(receiptAttachment(source, storedPath));
  }
  return ok({ attachments, mutations });
}

async function planObservationLogMutation(
  state: WorkspaceState,
  log: import("../artifacts/observations.js").ObservationLog,
  expected: import("../artifacts/observations.js").ObservationLog | undefined,
): Promise<Result<FileMutation>> {
  const path = state.paths.evidenceFile(log.feature, log.task, "observations.json");
  const current = await state.files.readTextIfExists(path);
  if (!current.ok) return current;
  if (!sameObservationLog(current.value, expected)) {
    return err(
      vispError("IO_ERROR", "Observation receipts changed during ingestion", {
        recovery: "Review the concurrent observation, then record this observation again",
      }),
    );
  }
  return ok({
    kind: "write",
    path,
    content: `${JSON.stringify(log, null, 2)}\n`,
    expectedBefore: filePrecondition(current.value),
  });
}

function sameObservationLog(
  content: string | undefined,
  expected: import("../artifacts/observations.js").ObservationLog | undefined,
): boolean {
  if (content === undefined) return expected === undefined;
  try {
    return hashValue(JSON.parse(content)) === hashValue(expected);
  } catch {
    return false;
  }
}

async function readStoredAttachment(
  state: WorkspaceState,
  destination: string,
): Promise<Result<string | undefined>> {
  const bytes = await state.files.readBytesIfExists(destination);
  if (!bytes.ok) return bytes;
  return ok(bytes.value ? digestBytes(Buffer.from(bytes.value)) : undefined);
}

function receiptAttachment(source: AttachmentSource, storedPath: string): ObservationAttachment {
  return {
    sourcePath: source.sourcePath,
    storedPath,
    sha256: source.digest,
    ...(source.dimensions ? { dimensions: source.dimensions } : {}),
  };
}

async function attachmentStaleReasons(
  state: WorkspaceState,
  receipt: ObservationReceipt,
): Promise<string[]> {
  const issues = await Promise.all(
    receipt.attachments.map(async (attachment) => ({
      attachment,
      issue: await attachmentIssue(state, attachment),
    })),
  );
  return issues.flatMap(({ attachment, issue }) =>
    issue ? [`attachment ${issue}: ${attachment.storedPath}`] : [],
  );
}

async function attachmentIssue(
  state: WorkspaceState,
  attachment: ObservationAttachment,
): Promise<"missing" | "changed" | undefined> {
  try {
    const path = state.paths.absolute(attachment.storedPath);
    const metadata = await state.files.metadata(path);
    if (!metadata.ok) return "changed";
    if (!metadata.value) return "missing";
    if (metadata.value.type !== "file") return "changed";
    const bytes = await state.files.readBytes(path);
    if (!bytes.ok) return bytes.error.code === "ARTIFACT_MISSING" ? "missing" : "changed";
    return digestBytes(Buffer.from(bytes.value)) === attachment.sha256 ? undefined : "changed";
  } catch {
    return "changed";
  }
}

function observationContentHash(receipt: ObservationReceipt): string {
  return hashValue({
    identityVersion: receipt.identityVersion,
    feature: receipt.feature,
    task: receipt.task,
    requirement: receipt.requirement,
    criterion: receipt.criterion,
    criterionStatement: receipt.criterionStatement,
    source: receipt.source,
    result: receipt.result,
    note: receipt.note,
    viewport: receipt.viewport,
    capture: receipt.capture,
    route: receipt.route,
    steps: receipt.steps,
    environment: receipt.environment,
    specHash: receipt.specHash,
    contextManifestHash: receipt.contextManifestHash,
    subjectHash: receipt.subjectHash,
    sourceHash: receipt.sourceHash,
    attachments: receipt.attachments.map((attachment) => ({
      sha256: attachment.sha256,
      dimensions: attachment.dimensions,
    })),
  });
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
