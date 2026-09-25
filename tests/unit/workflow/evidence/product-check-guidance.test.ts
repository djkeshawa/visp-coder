import { afterEach, expect, it } from "vitest";
import {
  productCheckGuidance,
  productCheckTemplate,
} from "../../../../src/workflow/product/check-guidance.js";
import { productBriefSchema, productCheckSchema } from "../../../../src/workflow/product/model.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  for (const p of projects.splice(0)) await p.workspace.destroy();
});

it("prints parser-compatible browser and backend check examples without modifying state or claiming coverage", async () => {
  const p = await productWorkspace();
  projects.push(p);
  const w = await p.workspace.state();
  const before = await readProductRecord(w);
  for (const kind of ["command", "browser"]) {
    const result = await productCheckTemplate(w, kind);
    expect(result.ok).toBe(true);
    if (!result.ok) continue;
    expect(productCheckSchema.safeParse({ id: "C099", ...result.value.example }).success).toBe(
      true,
    );
    expect(result.value.example.outcomes).toEqual([]);
    expect(result.value.outcomes).toContainEqual(expect.objectContaining({ id: "O001" }));
  }
  expect(await productCheckTemplate(w, "made-up")).toMatchObject({ ok: false });
  expect(await readProductRecord(w)).toEqual(before);
});

it("keeps unlinked checks legal and gives bounded scoped advice without inventing links", () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-api",
    originalRequest: "Build an API",
    goal: "API",
    outcomes: [{ id: "O1", kind: "functional", statement: "Returns result" }],
    checks: Array.from({ length: 5 }, (_, i) => ({
      id: `C${i}`,
      command: ["node", "test-helper.mjs"],
    })),
    slices: [
      {
        id: "T001",
        goal: "API",
        outcomes: ["O1"],
        checks: ["C0"],
        scope: { allowed: ["api.mjs"] },
      },
    ],
  });
  const before = JSON.stringify(brief);
  expect(productCheckGuidance(brief)).toMatchObject({
    advisory: true,
    unlinkedChecks: ["C0", "C1", "C2"],
    omitted: 2,
  });
  expect(productCheckGuidance(brief, brief.slices[0])?.unlinkedChecks).toEqual(["C0"]);
  expect(JSON.stringify(brief)).toBe(before);
  const first = brief.checks[0];
  if (!first) throw new Error("Missing check fixture");
  first.outcomes = ["O1"];
  expect(productCheckGuidance(brief, brief.slices[0])).toBeUndefined();
});
