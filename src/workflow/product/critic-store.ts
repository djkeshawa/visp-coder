import { join } from "node:path";
import { vispError } from "../../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
} from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { planCriticBudgetMutation } from "./critic-budget.js";
import { type CriticPhase, type CriticState, criticStateSchema } from "./critic-model.js";
import { closedSlice, type ProductBrief, type ProductSlice, type ProductState } from "./model.js";
import { selectProductSlice } from "./scopes.js";
import {
  briefPath,
  json,
  type ProductRecord,
  type ProductSelection,
  productStatePath,
  readProductRecord,
} from "./store.js";
import { productContractDigest } from "./subject.js";

export async function criticSelection(
  workspace: WorkspaceState,
  input: ProductSelection & { phase?: CriticPhase },
) {
  const loaded = await readProductRecord(workspace, input);
  if (!loaded.ok) return loaded;
  const selected = selectProductSlice(workspace, loaded.value, input);
  if (!selected.ok) return selected;
  const record = loaded.value;
  const slice =
    input.task === undefined &&
    record.brief.slices.every((s) => closedSlice(record.state.slices[s.id]?.status))
      ? record.brief.slices.length === 1
        ? record.brief.slices[0]
        : undefined
      : selected.value;
  const task = slice?.id;
  return ok({
    phase: input.phase ?? "product",
    record,
    slice,
    selection: { feature: record.brief.feature, task },
    contract:
      input.phase === "understanding"
        ? hashValue({ version: 1, phase: "understanding", brief: record.brief })
        : productContractDigest(record.brief, slice),
    intent: criticIntent(record.brief, slice),
    path: join(
      workspace.paths.featureDir(record.brief.feature),
      `critic/${hashValue({ root: workspace.paths.root, task }).slice(0, 24)}.json`,
    ),
  });
}
export type CriticSelection = Extract<
  Awaited<ReturnType<typeof criticSelection>>,
  { ok: true }
>["value"];
export async function readCriticState(
  workspace: WorkspaceState,
  selected: CriticSelection,
): Promise<Result<{ text: string | undefined; state?: CriticState }>> {
  const read = await workspace.files.readTextIfExists(selected.path);
  if (!read.ok) return read;
  if (read.value === undefined) {
    const config = selected.record.state.criticDefault;
    const state: CriticState | undefined =
      config && selected.record.state.status === "active"
        ? {
            version: 1,
            root: hashValue(workspace.paths.root),
            feature: selected.selection.feature,
            task: selected.selection.task,
            contract: selected.contract,
            intent: selected.intent,
            config,
            disabled: false,
            attempts: [],
          }
        : undefined;
    return ok({ text: undefined, state });
  }
  try {
    const state = criticStateSchema.parse(JSON.parse(read.value));
    if (
      state.root !== hashValue(workspace.paths.root) ||
      state.feature !== selected.selection.feature ||
      state.task !== selected.selection.task
    )
      return err(
        vispError("ARTIFACT_INVALID", "Critic state belongs to a different worktree or selection"),
      );
    return ok({ text: read.value, state });
  } catch {
    return err(vispError("ARTIFACT_INVALID", "Invalid critic state"));
  }
}
export function recordGuards(
  workspace: WorkspaceState,
  record: ProductRecord,
  nextState: ProductState = record.state,
): FileMutation[] {
  return [
    {
      kind: "write",
      path: briefPath(workspace, record.brief.feature),
      content: record.briefText,
      expectedBefore: filePrecondition(record.briefText),
    },
    {
      kind: "write",
      path: productStatePath(workspace, record.brief.feature),
      content: nextState === record.state ? record.stateText : json(nextState),
      expectedBefore: filePrecondition(record.stateText),
    },
  ];
}
export async function saveCriticState(
  workspace: WorkspaceState,
  selected: CriticSelection,
  before: string | undefined,
  state: CriticState,
  extra: FileMutation[] = [],
) {
  const budget = await planCriticBudgetMutation(workspace, selected.path, state);
  if (!budget.ok) return budget;
  const result = await applyFileTransaction(workspace.paths.root, "critic-experiment", [
    budget.value,
    ...recordGuards(workspace, selected.record, {
      ...selected.record.state,
      criticBudgetVersion: 1,
    }),
    {
      kind: "write",
      path: selected.path,
      content: json(state),
      expectedBefore: filePrecondition(before),
    },
    ...extra,
  ]);
  return result.ok ? ok(undefined) : result;
}

/** Durable promises, separate from revisable design and implementation choices. */
export function criticIntent(brief: ProductBrief, slice?: ProductSlice) {
  return hashValue({
    originalRequest: brief.originalRequest,
    outcomes: brief.outcomes.filter((outcome) => !slice || slice.outcomes.includes(outcome.id)),
    examples: brief.examples.filter(
      (example) => !slice || example.outcomes.some((id) => slice.outcomes.includes(id)),
    ),
    acceptanceBaseline: brief.acceptanceBaseline,
  });
}
