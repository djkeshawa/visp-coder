import { chmod, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import type { ProductBrief } from "../../../../src/workflow/product/model.js";
import {
  checkProductScope,
  readProductAuthorization,
} from "../../../../src/workflow/product/scopes.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
afterEach(async () => setup?.workspace.destroy());

const GUIDANCE = "docs/guidance.md";

async function createGuidance(entry: string) {
  if (entry === "symlink") {
    await mkdir(join(setup.workspace.root, "docs"));
    await symlink("../src/value.mjs", join(setup.workspace.root, GUIDANCE));
  } else {
    await setup.workspace.write(GUIDANCE, "Keep the project's conventions.\n");
    await chmod(join(setup.workspace.root, GUIDANCE), 0o644);
  }
  setup.workspace.git("add", GUIDANCE);
  setup.workspace.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "guidance baseline");
}

async function changeGuidance(entry: string, change: string) {
  if (change === "content") {
    if (entry === "symlink") {
      await rm(join(setup.workspace.root, GUIDANCE));
      await symlink("../test/value.test.mjs", join(setup.workspace.root, GUIDANCE));
    } else await setup.workspace.write(GUIDANCE, "Changed conventions.\n");
  }
  if (change === "mode") await chmod(join(setup.workspace.root, GUIDANCE), 0o755);
  if (change === "deleted") await rm(join(setup.workspace.root, GUIDANCE));
}

async function revise(brief: ProductBrief) {
  const updated = await updateProductBrief(await setup.workspace.state(), {
    brief,
    reason: "Adjust declared inputs without changing the product outcome",
  });
  if (!updated.ok) throw new Error(updated.error.message);
}

it.each(
  ["raw baseline", "git baseline"].flatMap((representation) => [
    ...["unchanged", "content", "mode", "deleted"].map((change) => ({
      representation,
      change,
      entry: "file",
    })),
    ...["unchanged", "content", "deleted"].map((change) => ({
      representation,
      change,
      entry: "symlink",
    })),
  ]),
)(
  "compares $representation with a different current representation: $entry $change",
  async ({ representation, change, entry }) => {
    setup = await productWorkspace();
    await createGuidance(entry);
    const broad: ProductBrief = {
      ...setup.brief,
      slices: setup.brief.slices.map((slice) => ({
        ...slice,
        scope: { ...slice.scope, allowed: ["**"] },
      })),
    };
    await revise(representation === "raw baseline" ? broad : setup.brief);
    const state = await setup.workspace.state();
    expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
    const before = await readProductRecord(state);
    if (!before.ok) throw new Error(before.error.message);
    const original = await readProductAuthorization(state, before.value);
    if (!original.ok || !original.value) throw new Error("Missing authorization");
    expect(original.value.baseline[GUIDANCE]?.startsWith("git:")).toBe(
      representation === "git baseline",
    );

    // Narrow a broad grant, or declare a previously undeclared file as check input.
    await revise(
      representation === "raw baseline"
        ? setup.brief
        : {
            ...setup.brief,
            checks: setup.brief.checks.map((check) => ({
              ...check,
              files: [...check.files, GUIDANCE],
            })),
          },
    );
    await changeGuidance(entry, change);
    expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
    const record = await readProductRecord(state);
    if (!record.ok) throw new Error(record.error.message);
    const retained = await readProductAuthorization(state, record.value);
    expect(retained.ok && retained.value?.baseline).toEqual(original.value.baseline);
    const snapshot = await productSourceSnapshot(state, record.value.brief);
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    if (change !== "deleted") {
      expect(snapshot.value[GUIDANCE]?.startsWith("git:")).toBe(representation === "raw baseline");
      expect(snapshot.value[GUIDANCE]).not.toBe(original.value.baseline[GUIDANCE]);
    }
    const slice = record.value.brief.slices[0];
    if (!slice) throw new Error("Missing slice");
    expect(await checkProductScope(state, record.value, slice)).toMatchObject(
      change === "unchanged"
        ? { ok: true, value: { committedChanges: [] } }
        : { ok: false, error: { code: "SCOPE_VIOLATION", details: { outside: [GUIDANCE] } } },
    );
  },
);
