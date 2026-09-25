import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { runProductReview, runProductStatus } from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { reviewInputTemplate } from "../../../../src/workflow/product-inputs.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace?.destroy();
});
it("reads source once per status but refreshes on the next call and does not mutate state", async () => {
  ({ workspace } = await productWorkspace());
  const state = await workspace.state();
  const before = await readProductRecord(state);
  const reads = vi.spyOn(state.files, "readBytesIfExists");
  const first = await runProductStatus(state);
  expect(first.ok).toBe(true);
  expect(reads.mock.calls.filter(([path]) => path === "src/value.mjs")).toHaveLength(1);
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  const second = await runProductStatus(state);
  expect(reads.mock.calls.filter(([path]) => path === "src/value.mjs")).toHaveLength(2);
  if (!first.ok || !second.ok) throw new Error("Missing status");
  expect(second.value.subjectDigest).not.toBe(first.value.subjectDigest);
  expect(await readProductRecord(state)).toEqual(before);
});

it("reads source once per review while refreshing the next review after an edit", async () => {
  ({ workspace } = await productWorkspace());
  const state = await workspace.state();
  const reads = vi.spyOn(state.files, "readBytesIfExists");
  const metadata = vi.spyOn(state.files, "readMetadata");
  const first = await runProductReview(state);
  expect(first.ok).toBe(true);
  expect(reads.mock.calls.filter(([path]) => path === "src/value.mjs")).toHaveLength(2);
  expect(metadata.mock.calls.filter(([path]) => path === "src/value.mjs")).toHaveLength(2);

  await workspace.write("src/value.mjs", "export const value = 2;\n");
  const second = await runProductReview(state);
  expect(second.ok).toBe(true);
  expect(reads.mock.calls.filter(([path]) => path === "src/value.mjs")).toHaveLength(4);
  expect(metadata.mock.calls.filter(([path]) => path === "src/value.mjs")).toHaveLength(4);
  if (!first.ok || !second.ok) throw new Error("Missing review");
  expect(second.value.subjectDigest).not.toBe(first.value.subjectDigest);
});
it("does not append duplicate reviews or consume cycles for unavailable evidence", async () => {
  ({ workspace } = await productWorkspace());
  const bundle = await runProductReview(await workspace.state());
  if (!bundle.ok) throw new Error(bundle.error.message);
  const options = {
    subjectDigest: bundle.value.subjectDigest,
    assessments: [{ outcome: "O001", status: "unavailable", summary: "Reviewer unavailable" }],
  };
  const first = await runProductReview(await workspace.state(), options);
  const before = await readProductRecord(await workspace.state());
  expect(await runProductReview(await workspace.state(), options)).toMatchObject({
    ok: true,
    value: { refinement: { used: 0 } },
  });
  expect(await readProductRecord(await workspace.state())).toEqual(before);
  expect(first).toMatchObject({ ok: true, value: { refinement: { used: 0 } } });
});

it("keeps review drafts outside source identity and explains stale product-tree drafts", async () => {
  ({ workspace } = await productWorkspace());
  const state = await workspace.state();
  const bundle = await runProductReview(state);
  if (!bundle.ok) throw new Error(bundle.error.message);
  const submission = {
    ...reviewInputTemplate(bundle.value),
    assessments: [{ outcome: "O001", status: "unclear", summary: "Not yet exercised" }],
  };
  await workspace.write(".visp/drafts/review.json", JSON.stringify(submission));
  expect(await runProductReview(state, submission)).toMatchObject({ ok: true });
  await workspace.write("review.json", JSON.stringify(submission));
  expect(await runProductReview(state, submission)).toMatchObject({
    ok: false,
    error: {
      code: "EVIDENCE_FAILED",
      recovery: "visp review --template",
      message: expect.stringContaining(".visp/drafts"),
    },
  });
});

it("changes evidence freshness for VISP configuration edits without spending a product correction", async () => {
  ({ workspace } = await productWorkspace());
  const state = await workspace.state();
  const before = await runProductReview(state);
  if (!before.ok) throw new Error(before.error.message);
  const assessments = [
    { outcome: "O001", status: "failed", summary: "Public behavior still fails" },
  ];
  expect(
    await runProductReview(state, { subjectDigest: before.value.subjectDigest, assessments }),
  ).toMatchObject({ ok: true, value: { refinement: { used: 0 } } });
  await workspace.write(
    "visp.yml",
    `${await readFile(state.paths.config, "utf8")}\n# Local configuration annotation\n`,
  );
  const changed = await runProductReview(await workspace.state());
  if (!changed.ok) throw new Error(changed.error.message);
  expect(changed.value.subjectDigest).not.toBe(before.value.subjectDigest);
  expect(
    await runProductReview(await workspace.state(), {
      subjectDigest: changed.value.subjectDigest,
      assessments,
    }),
  ).toMatchObject({ ok: true, value: { refinement: { used: 0 } } });
});
