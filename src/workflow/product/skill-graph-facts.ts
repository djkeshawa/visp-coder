import { matchesAny } from "../../core/patterns.js";
import { type GraphSnapshot, openProjectStore } from "../../graph/index.js";
import type { ApplicationFacts } from "../../skills/applies.js";
import type { SkillRecord } from "../../skills/schema.js";
import type { WorkspaceState } from "../state.js";
import { productGraphCurrencyGap } from "./context-graph.js";
import type { ProductSlice } from "./model.js";

type GraphFacts = Pick<ApplicationFacts, "languages" | "entrypointKinds">;
interface ObservedFacts {
  readonly facts: GraphFacts;
  readonly notes: string[];
}

/** Read graph facts only when an admitted trigger needs them; never infer from configuration. */
export async function skillGraphFacts(
  workspace: WorkspaceState,
  slice: ProductSlice,
  skills: readonly SkillRecord[],
): Promise<ObservedFacts> {
  const needed = skills.some(
    (skill) =>
      skill.state === "admitted" &&
      (skill.appliesTo?.language.length || skill.appliesTo?.entrypointKind.length),
  );
  if (!needed) return { facts: {}, notes: [] };
  const exists = await workspace.files.exists(workspace.paths.graphStore);
  if (!exists.ok) return unavailable(exists.error.message);
  if (!exists.value) return unavailable("no index exists");
  const store = await openProjectStore(workspace.files, workspace.paths.graphStore, {
    writable: false,
  });
  if (!store.ok) return unavailable(store.error.message);
  try {
    const head = store.value.requireHead();
    if (!head.ok) return unavailable(head.error.message);
    const gap = await productGraphCurrencyGap(workspace, head.value);
    if (gap) return unavailable(gap);
    return {
      facts: scopedFacts(head.value, slice),
      notes: [
        `Skill graph facts observed from snapshot ${head.value.id}, checked against current repository inputs and limited to declared slice paths. These are advisory observations, not edit authority.`,
      ],
    };
  } finally {
    store.value.close();
  }
}

function unavailable(reason: string): ObservedFacts {
  return {
    facts: {},
    notes: [
      `Skill graph facts unavailable: ${reason}. Refresh through visp work; inspect source directly if indexing is unavailable.`,
    ],
  };
}

function scopedFacts(snapshot: GraphSnapshot, slice: ProductSlice): GraphFacts {
  const scope = [...slice.scope.allowed, ...slice.scope.expected];
  const scoped = new Set(
    snapshot.files.filter((file) => matchesAny(file.path, scope)).map((file) => file.path),
  );
  const parsed = new Set(
    snapshot.entities.filter((entity) => entity.kind === "file").map((entity) => entity.path),
  );
  return {
    languages: [
      ...new Set(
        snapshot.files
          .filter(
            (file) => scoped.has(file.path) && parsed.has(file.path) && file.language !== "other",
          )
          .map((file) => file.language),
      ),
    ].sort(),
    entrypointKinds: [
      ...new Set(
        snapshot.entrypoints.filter((entry) => scoped.has(entry.path)).map((entry) => entry.kind),
      ),
    ].sort(),
  };
}
