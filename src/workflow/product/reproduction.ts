import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { requireNoPendingCriticReview } from "./critic-policy.js";
import { outstandingFeedback } from "./findings.js";
import { witnessedFunctionalFailure } from "./functional-resolution.js";
import { reproductionSchema } from "./reproduction-model.js";
import { withProductMutation } from "./runtime.js";
import { readProductRecord, saveProductState } from "./store.js";
import { productSourceDigest } from "./subject.js";

export const reproductionRequestSchema = z
  .object({
    feature: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    finding: z.string().min(1),
    execution: z.string().min(1),
    explanation: z.string().trim().min(1),
  })
  .strict();

/** Attach before repair, while the failed receipt still describes the current product. */
export async function runProductReproduction(workspace: WorkspaceState, input: unknown) {
  const parsed = reproductionRequestSchema.safeParse(input);
  if (!parsed.success) return err(vispError("ARTIFACT_INVALID", parsed.error.message));
  return withProductMutation(workspace, () => attach(workspace, parsed.data));
}

async function attach(
  workspace: WorkspaceState,
  request: z.infer<typeof reproductionRequestSchema>,
) {
  const loaded = await readProductRecord(workspace, request);
  if (!loaded.ok) return loaded;
  const record = loaded.value;
  if (record.state.status !== "active")
    return err(vispError("STAGE_BLOCKED", "Reproduction requires an active feature"));
  const allowed = await requireNoPendingCriticReview(
    workspace,
    record.brief.feature,
    "Submit or expire the pending review before attaching a reproduction",
  );
  if (!allowed.ok) return allowed;
  const finding = outstandingFeedback(record).find((entry) => entry.id === request.finding);
  if (
    finding?.phase !== "product" ||
    finding.dimension !== "functional" ||
    (request.task !== undefined && request.task !== finding.task)
  )
    return err(
      vispError("ARTIFACT_INVALID", "Select an unresolved functional finding in its owning slice"),
    );
  const subject = await productSourceDigest(workspace, record.brief);
  if (!subject.ok) return subject;
  const execution = witnessedFunctionalFailure(record, finding, request.execution, subject.value);
  if (!execution)
    return err(
      vispError(
        "EVIDENCE_MISSING",
        "Attach a unique current failed behavioral execution with verifier and environment identity in the finding's scope, before changing the product",
      ),
    );
  const existing = (record.state.reproductions ?? []).find(
    (entry) =>
      (entry.finding === finding.id || entry.finding === finding.legacyId) &&
      entry.findingSubject === finding.subjectDigest &&
      entry.execution === execution.id &&
      entry.executionDigest === hashValue(execution),
  );
  if (existing) return ok(existing);
  const entry = reproductionSchema.parse({
    version: 1,
    finding: finding.id,
    findingSubject: finding.subjectDigest,
    execution: execution.id,
    executionDigest: hashValue(execution),
    explanation: request.explanation,
    createdAt: new Date().toISOString(),
    provenance: "caller-reported",
  });
  const saved = await saveProductState(workspace, record, {
    ...record.state,
    updatedAt: entry.createdAt,
    reproductions: [...(record.state.reproductions ?? []), entry],
  });
  return saved.ok ? ok(entry) : saved;
}
