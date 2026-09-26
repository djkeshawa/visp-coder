/**
 * Historical observation writer, kept only to build observation records for reader tests.
 * VISP no longer records observations this way; `readObservationViews` still reads them.
 */
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { vispError } from "../../../src/core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
  withStateMutation,
} from "../../../src/core/file-transaction.js";
import { hashValue, sha256 } from "../../../src/core/hash.js";
import { isPortableAbsolute, toPosix } from "../../../src/core/paths.js";
import { err, ok, type Result } from "../../../src/core/result.js";
import { now } from "../../../src/workflow/artifacts/common.js";
import type { QualityRequirement, Requirement } from "../../../src/workflow/artifacts/feature.js";
import {
  type ObservationAttachment,
  type ObservationEnvironment,
  type ObservationReceipt,
  observationResultSchema,
  observationSourceSchema,
} from "../../../src/workflow/artifacts/observations.js";
import { findTask } from "../../../src/workflow/artifacts/tasks.js";
import {
  criterionContractHash,
  type OwnedCriterion,
  ownedCriterionView,
  semanticObservationHash,
} from "../../../src/workflow/evidence/observations/freshness.js";
import { observationReproductionState } from "../../../src/workflow/evidence/observations/identity.js";
import { digestBytes, imageDimensions } from "../../../src/workflow/evidence/observations/media.js";
import {
  attachmentStaleReasons,
  type RecordObservationOptions,
  reproductionSignature,
} from "../../../src/workflow/evidence/observations.js";
import { stableContextHash } from "../../../src/workflow/stages/context/digest.js";
import { currentContextSourceHash } from "../../../src/workflow/stages/context/freshness.js";
import type { WorkspaceState } from "../../../src/workflow/state.js";
import { legacyStore } from "./legacy-store.js";

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
  readonly task: import("../../../src/workflow/artifacts/tasks.js").Task;
  readonly owned: OwnedCriterion;
  readonly specHash: string;
  readonly contextManifestHash: string;
  readonly subjectHash: string;
  readonly sourceHash: string;
  readonly existing?: import("../../../src/workflow/artifacts/observations.js").ObservationLog;
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
    legacyStore(state).readTasks(options.feature),
    legacyStore(state).readSpec(options.feature),
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
  log: import("../../../src/workflow/artifacts/observations.js").ObservationLog,
  expected: import("../../../src/workflow/artifacts/observations.js").ObservationLog | undefined,
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
  expected: import("../../../src/workflow/artifacts/observations.js").ObservationLog | undefined,
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

function validateVisualContext(options: RecordObservationOptions): string | undefined {
  if (options.source !== "browser") return undefined;
  if ((options.artifacts ?? []).length === 0) {
    return "A browser observation requires at least one screenshot or video artifact";
  }
  if (!(options.artifacts ?? []).every(isVisualArtifact)) {
    return "Browser artifacts must be screenshots or videos (png, jpg, jpeg, webp, gif, mp4, or webm)";
  }
  if (!options.viewport) return "A browser observation requires the viewport width and height";
  if (!options.route?.trim()) return "A browser observation requires the observed route or URL";
  if ((options.steps ?? []).filter((step) => step.trim() !== "").length === 0) {
    return "A browser observation requires at least one reproduction step";
  }
  return undefined;
}

function isVisualArtifact(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|mp4|webm)$/i.test(path);
}

function validateBrowserAttachmentDimensions(
  options: RecordObservationOptions,
  attachments: readonly Pick<ObservationAttachment, "sourcePath" | "dimensions">[],
): string | undefined {
  if (options.source !== "browser" || !options.viewport) return undefined;
  const capture = options.capture ?? "viewport";
  for (const attachment of attachments) {
    if (!isImageArtifact(attachment.sourcePath) || !attachment.dimensions) continue;
    const scale = attachment.dimensions.width / options.viewport.width;
    if (!Number.isFinite(scale) || scale < 1 || scale > 4) {
      return `${attachment.sourcePath} width does not match viewport ${options.viewport.width}x${options.viewport.height}`;
    }
    const expectedHeight = options.viewport.height * scale;
    const heightMatches =
      capture === "full-page"
        ? attachment.dimensions.height + 1 >= expectedHeight
        : Math.abs(attachment.dimensions.height - expectedHeight) <= 1;
    if (!heightMatches) {
      return `${attachment.sourcePath} (${attachment.dimensions.width}x${attachment.dimensions.height}) does not match viewport ${options.viewport.width}x${options.viewport.height} for ${capture} capture`;
    }
  }
  return undefined;
}

function isImageArtifact(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(path);
}
