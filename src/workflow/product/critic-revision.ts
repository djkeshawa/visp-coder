import { join } from "node:path";
import { vispError } from "../../core/errors.js";
import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { type CriticState, criticStateSchema } from "./critic-model.js";
import { criticIntent } from "./critic-store.js";
import type { ProductBrief, ProductState } from "./model.js";
import { json, type ProductRecord } from "./store.js";

/** Joined to the validated brief transaction; never called by read-only navigation. */
export async function planCriticRevision(
  workspace: WorkspaceState,
  record: ProductRecord,
  brief: ProductBrief,
  revision: Pick<ProductState["revisions"][number], "reason" | "provenance" | "createdAt">,
  reconcile = false,
): Promise<Result<FileMutation[]>> {
  const directory = join(workspace.paths.featureDir(brief.feature), "critic");
  const entries = await workspace.files.listEntries(directory);
  if (!entries.ok) return entries;
  const mutations: FileMutation[] = [];
  for (const entry of entries.value) {
    if (!entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const read = await workspace.files.readText(path);
    if (!read.ok) return read;
    const revised = reviseCritic(
      read.value,
      hashValue(workspace.paths.root),
      record,
      brief,
      revision,
      reconcile,
    );
    if (!revised.ok) return revised;
    if (!revised.value) continue;

    mutations.push({
      kind: "write",
      path,
      content: json(revised.value),
      expectedBefore: filePrecondition(read.value),
    });
  }
  // record establishes that callers loaded and validated the same feature before planning.
  if (record.brief.feature !== brief.feature)
    return err(vispError("ARTIFACT_INVALID", "Feature identity changed"));
  return ok(mutations);
}

function reviseCritic(
  text: string,
  root: string,
  record: ProductRecord,
  brief: ProductBrief,
  revision: Pick<ProductState["revisions"][number], "reason" | "provenance" | "createdAt">,
  reconcile: boolean,
): Result<CriticState | undefined> {
  let parsed: ReturnType<typeof criticStateSchema.safeParse>;
  try {
    parsed = criticStateSchema.safeParse(JSON.parse(text));
  } catch {
    return err(vispError("ARTIFACT_INVALID", "Invalid critic history; brief unchanged"));
  }
  if (!parsed.success)
    return err(vispError("ARTIFACT_INVALID", "Invalid critic history; brief unchanged"));
  const state = parsed.data;
  if (state.root !== root) return ok(undefined);
  if (state.feature !== brief.feature)
    return err(vispError("ARTIFACT_INVALID", "Critic feature identity mismatch"));
  const slice = brief.slices.find((candidate) => candidate.id === state.task);
  if (state.task && !slice) return ok(undefined); // Retired selections remain historical.
  const intent = criticIntent(brief, slice);
  const repairDisabled = reconcile && state.disabled && record.state.criticEnabled === true;
  if (state.intent === intent && !repairDisabled) return ok(undefined);
  const next = {
    ...state,
    intent,
    disabled: repairDisabled ? false : state.disabled,
    preferredCandidate: undefined,
    attempts: state.attempts.map((attempt) =>
      attempt.status === "pending"
        ? {
            ...attempt,
            intent: attempt.intent ?? state.intent,
            status: "unavailable" as const,
            message: "Source or contract changed during critic review; result discarded",
          }
        : { ...attempt, intent: attempt.intent ?? state.intent },
    ),
    intentRevisions: [
      ...(state.intentRevisions ?? []),
      {
        before: state.intent,
        after: intent,
        briefDigest: hashValue(brief),
        reason: revision.reason,
        provenance: revision.provenance,
        createdAt: revision.createdAt,
      },
    ],
  };
  return ok(next);
}
