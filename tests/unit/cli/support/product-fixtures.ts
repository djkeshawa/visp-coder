import { hashValue } from "../../../../src/core/hash.js";
import type { ImplementMarker } from "../../../../src/workflow/artifacts/evidence.js";
import type { Task } from "../../../../src/workflow/artifacts/tasks.js";
import { runProductMigrate, updateProductBrief } from "../../../../src/workflow/product/index.js";
import { sliceDigest } from "../../../../src/workflow/product/model.js";
import { authorizationPath, readProductRecord } from "../../../../src/workflow/product/store.js";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import type { TestWorkspace } from "../../support/workspace.js";

/** Real migration supplies the committed scope; isolated guard tests then seed a current grant. */
export async function withProductFeature(
  workspace: TestWorkspace,
  feature: string,
  tasks: readonly Partial<Task>[] = [{}],
): Promise<void> {
  await workspace.withFeature(
    feature,
    tasks.map((task) => ({ ...task, requirements: ["REQ001"] })),
  );
  await workspace.withSpec(feature, [
    { id: "REQ001", statement: "Change the declared module", priority: "must", criteria: [] },
  ]);
  const migrated = await runProductMigrate(await workspace.state(), { feature });
  if (!migrated.ok) throw new Error(migrated.error.message);
}

export async function authorize(
  workspace: TestWorkspace,
  marker: Partial<ImplementMarker> & Pick<ImplementMarker, "feature" | "task">,
): Promise<void> {
  const state = await workspace.state();
  const loaded = await readProductRecord(state, marker);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const brief = loaded.value.brief;
  const updated = await updateProductBrief(state, {
    feature: marker.feature,
    reason: "Isolated guard fixture scope",
    brief: {
      ...brief,
      slices: brief.slices.map((slice) =>
        slice.id === marker.task
          ? {
              ...slice,
              scope: {
                allowed: marker.allowedFiles ?? slice.scope.allowed,
                expected: marker.expectedFiles ?? slice.scope.expected,
                forbidden: marker.forbiddenFiles ?? slice.scope.forbidden,
              },
            }
          : slice,
      ),
    },
  });
  if (!updated.ok) throw new Error(updated.error.message);
  const selected = updated.value.slices.find((slice) => slice.id === marker.task);
  if (!selected) throw new Error("Guard fixture slice is missing");
  const snapshot = await productSourceSnapshot(state, updated.value);
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  const written = await state.files.writeJson(authorizationPath(state, marker.feature), {
    version: 2,
    feature: marker.feature,
    task: marker.task,
    createdAt: new Date().toISOString(),
    root: hashValue(state.paths.root),
    contractDigest: sliceDigest(updated.value, selected),
    baseline: snapshot.value,
  });
  if (!written.ok) throw new Error(written.error.message);
}
