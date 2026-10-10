import { afterEach, expect, it, vi } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import { ok } from "../../../../src/core/result.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace;
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace?.destroy();
});

it("retries a brief and state pair observed during a validated update", async () => {
  ({ workspace } = await productWorkspace());
  const state = await workspace.state();
  const loaded = await readProductRecord(state);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const original = state.files.readText.bind(state.files);
  let reads = 0;
  vi.spyOn(state.files, "readText").mockImplementation(async (path) => {
    if (path.endsWith("product-state.json") && reads++ === 0)
      return ok(
        JSON.stringify({ ...loaded.value.state, briefDigest: hashValue("previous brief") }),
      );
    return original(path);
  });
  expect(await readProductRecord(state)).toMatchObject({ ok: true });
  expect(reads).toBeGreaterThan(1);
});
