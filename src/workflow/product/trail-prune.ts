import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import { ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { withProductMutation } from "./runtime.js";
import { readProductRecord, saveProductState } from "./store.js";
import { compactTrail, strings } from "./trail.js";

/** Remove only artifacts no longer referenced by the retained trail or live critic state. */
export function pruneProductTrail(workspace: WorkspaceState, feature?: string) {
  return withProductMutation<{
    removed: number;
    note?: string;
    executions?: number;
    captureRuns?: number;
  }>(workspace, async () => {
    const record = await readProductRecord(workspace, { feature });
    if (!record.ok) return record;
    const next = compactTrail(record.value.state);
    const references = strings(next);
    const inspected = await criticReferences(workspace, record.value.brief.feature, references);
    if (!inspected.ok) return inspected;
    if (!inspected.value)
      return ok({ removed: 0, note: "Critic history is unreadable; kept all files." });
    const planned = await orphanMutations(workspace, record.value.brief.feature, references);
    if (!planned.ok) return planned;
    const saved = await saveProductState(workspace, record.value, next, planned.value);
    return saved.ok
      ? ok({
          removed: planned.value.length,
          executions: next.executions.length,
          captureRuns: next.captureRuns.length,
        })
      : saved;
  });
}

async function criticReferences(
  workspace: WorkspaceState,
  feature: string,
  references: Set<string>,
): Promise<Result<boolean>> {
  const directory = workspace.paths.featureFile(feature, "critic");
  const critics = await workspace.files.listEntries(directory);
  if (!critics.ok) return critics;
  for (const entry of critics.value.filter(
    (entry) => entry.type === "file" && entry.name.endsWith(".json"),
  )) {
    const critic = await workspace.files.readText(`${directory}/${entry.name}`);
    if (!critic.ok) return critic;
    try {
      strings(JSON.parse(critic.value), references);
    } catch {
      return ok(false);
    }
  }
  return ok(true);
}

async function orphanMutations(
  workspace: WorkspaceState,
  feature: string,
  references: Set<string>,
): Promise<Result<FileMutation[]>> {
  const mutations: FileMutation[] = [];
  for (const directory of ["captures", "candidates"]) {
    const base = workspace.paths.featureFile(feature, directory);
    const entries = await workspace.files.listEntries(base);
    if (!entries.ok) return entries;
    for (const entry of entries.value.filter((entry) => entry.type === "file")) {
      const path = `${base}/${entry.name}`;
      if (referencedFile(workspace, path, entry.name, references)) continue;
      const removed = await removeOrphan(workspace, path);
      if (!removed.ok) return removed;
      mutations.push(removed.value);
    }
  }
  return ok(mutations);
}

function referencedFile(
  workspace: WorkspaceState,
  path: string,
  name: string,
  references: Set<string>,
) {
  const identity = name.replace(/\.(json|png)$/, "").replace(/^run-/, "");
  return references.has(identity) || references.has(workspace.paths.relative(path) ?? path);
}

async function removeOrphan(
  workspace: WorkspaceState,
  path: string,
): Promise<Result<FileMutation>> {
  const content = await workspace.files.readBytes(path);
  if (!content.ok) return content;
  const meta = await workspace.files.readMetadata(path);
  return meta.ok
    ? ok({
        kind: "remove",
        path,
        expectedBefore: filePrecondition(content.value, meta.value?.mode),
      })
    : meta;
}
