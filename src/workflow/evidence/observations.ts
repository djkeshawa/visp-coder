import { hashValue } from "../../core/hash.js";
import { ok, type Result } from "../../core/result.js";
import type { Spec } from "../artifacts/feature.js";
import type {
  ObservationAttachment,
  ObservationCapture,
  ObservationEnvironment,
  ObservationReceipt,
  ObservationView,
  ObservationViewport,
} from "../artifacts/observations.js";
import { currentContextSourceHash } from "../stages/context/freshness.js";
import type { WorkspaceState } from "../state.js";
import { staleReasonsFor } from "./observations/freshness.js";
import { observationReproductionState } from "./observations/identity.js";
import { digestBytes } from "./observations/media.js";

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

export function reproductionSignature(receipt: ObservationReceipt): string {
  return hashValue({
    version: receipt.identityVersion ?? 1,
    state: observationReproductionState(receipt),
  });
}

export { observationReproductionState } from "./observations/identity.js";

async function readOneLog(
  state: WorkspaceState,
  feature: string,
  task: string,
): Promise<Result<import("../artifacts/observations.js").ObservationLog[]>> {
  const log = await state.store.readObservations(feature, task);
  if (!log.ok) return log;
  return ok(log.value ? [log.value] : []);
}

export async function attachmentStaleReasons(
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

export async function attachmentIssue(
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
