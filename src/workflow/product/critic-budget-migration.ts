import { CRITIC_MAX_CALLS } from "../../config/critic.js";
import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import { ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { featureCriticCapacity, readFeatureCriticBudget } from "./critic-budget.js";
import { productStateSchema } from "./model.js";
import { briefPath, json, type ProductRecord, productStatePath } from "./store.js";

export interface CriticBudgetMigration {
  version: 1;
  callsUsed: number;
  maxCalls: number;
  reservedMs: number;
}

/** Compose with other history upgrades; standalone application supplies the raw backup. */
export async function planCriticBudgetMigration(
  workspace: WorkspaceState,
  record: ProductRecord,
  prior: FileMutation[],
) {
  const loaded = await readFeatureCriticBudget(workspace, record.brief.feature, {
    maxCalls: record.state.criticDefault?.maxCalls ?? CRITIC_MAX_CALLS,
  });
  if (!loaded.ok) return loaded;
  const { budget, path, text } = loaded.value;
  if (text === undefined && !loaded.value.historyCount)
    return ok({ mutations: prior, report: undefined });
  const capacity = featureCriticCapacity(budget);
  const report: CriticBudgetMigration = {
    version: 1,
    callsUsed: capacity.callsUsed,
    maxCalls: capacity.limit,
    reservedMs: capacity.reservedMs,
  };
  const content = json(budget);
  if (record.state.criticBudgetVersion === 1 && content === text)
    return ok({ mutations: prior, report });
  const statePath = productStatePath(workspace, record.brief.feature);
  const existing = prior.find((mutation) => mutation.path === statePath);
  // Finding migration may reopen acceptance. Retain that planned state in this same write.
  const state =
    existing?.kind === "write"
      ? productStateSchema.parse(
          JSON.parse(
            typeof existing.content === "string"
              ? existing.content
              : Buffer.from(existing.content).toString("utf8"),
          ),
        )
      : record.state;
  const mutations = prior.filter((mutation) => mutation.path !== statePath);
  mutations.push(
    ...loaded.value.historyGuards,
    { kind: "write", path, content, expectedBefore: filePrecondition(text) },
    {
      kind: "write",
      path: statePath,
      content: json({ ...state, criticBudgetVersion: 1 }),
      expectedBefore: filePrecondition(record.stateText),
    },
  );
  const contractPath = briefPath(workspace, record.brief.feature);
  if (!mutations.some((mutation) => mutation.path === contractPath))
    mutations.push({
      kind: "write",
      path: contractPath,
      content: record.briefText,
      expectedBefore: filePrecondition(record.briefText),
    });
  return ok({ mutations, report });
}
