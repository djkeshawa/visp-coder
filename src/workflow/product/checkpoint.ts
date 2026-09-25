import { vispError } from "../../core/errors.js";
import { err, ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { applicableExecutions } from "./assessment.js";
import { prepareCandidate } from "./candidate.js";
import { criticSelection } from "./critic-store.js";
import { runProductReviewerHandoff } from "./reviewer-handoff.js";
import { type ProductSelection, saveProductState } from "./store.js";

/** One first-observed baseline per slice, without another agent-authored document or model call. */
export async function ensureProductCheckpoint(workspace: WorkspaceState, input: ProductSelection) {
  const selected = await criticSelection(workspace, input);
  if (!selected.ok) return selected;
  const { record, selection } = selected.value;
  if (!selection.task || record.state.status === "historical-complete") return ok(undefined);
  const existing = record.state.checkpoints?.find((entry) => entry.task === selection.task);
  if (existing) return ok(existing);
  const handoff = await runProductReviewerHandoff(workspace, selection);
  if (!handoff.ok) return handoff;
  const visual = record.brief.outcomes.some(
    (outcome) =>
      outcome.kind === "experience" && selected.value.slice?.outcomes.includes(outcome.id),
  );
  if (visual && handoff.value.images.length === 0) return ok(undefined);
  if (
    !applicableExecutions(record, handoff.value.subjectDigest).some(
      (entry) => entry.task === selection.task && entry.status === "passed",
    )
  )
    return ok(undefined);
  const prepared = await prepareCandidate(workspace, selected.value, handoff.value);
  if (!prepared.ok) return prepared;
  if (prepared.value.candidate.subject !== handoff.value.subjectDigest)
    return err(vispError("STATE_BUSY", "Source changed while preserving the observed candidate"));
  const checkpoint = {
    task: selection.task,
    candidate: prepared.value.candidate.id,
    subject: prepared.value.candidate.subject,
    intent: selected.value.intent,
  };
  const saved = await saveProductState(
    workspace,
    record,
    {
      ...record.state,
      checkpoints: [...(record.state.checkpoints ?? []), checkpoint],
    },
    prepared.value.mutations,
  );
  return saved.ok ? ok(checkpoint) : saved;
}
