import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { hashValue, sha256 } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import { runProductMigrate, updateProductBrief } from "../../../../src/workflow/product/index.js";
import {
  briefPath,
  productStatePath,
  readProductRecord,
} from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace;
let brief: Awaited<ReturnType<typeof productWorkspace>>["brief"];
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
beforeEach(async () => {
  ({ workspace, brief } = await productWorkspace());
});
afterEach(async () => {
  await workspace.destroy();
});

describe("immutable product request", () => {
  it("cannot authorize a rewritten request by editing historical intent first", async () => {
    const state = await workspace.state();
    const before = await readFile(productStatePath(state, brief.feature), "utf8");
    const legacy = value(await state.store.readIntent(brief.feature));
    const replacement = "The old original request no longer matters";
    value(
      await state.store.writeIntent({
        ...legacy,
        sourceBrief: replacement,
        sourceBriefHash: sha256(replacement),
      }),
    );
    const result = await updateProductBrief(await workspace.state(), {
      brief: { ...brief, originalRequest: replacement },
      intentChange: { reason: "Change outcomes", provenance: "explicit caller claim" },
    });
    // The rewrite is ignored and reported, never applied.
    expect(result).toMatchObject({
      ok: true,
      value: {
        originalRequest: brief.originalRequest,
        normalized: [expect.stringContaining("originalRequest: VISP keeps the recorded request")],
      },
    });
    expect(await readFile(productStatePath(state, brief.feature), "utf8")).toBe(before);
  });

  it("does not consult malformed historical intent when revising a current method", async () => {
    await workspace.write(`.visp/features/${brief.feature}/intent.json`, "{}\n");
    const revised = value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          slices: brief.slices.map((slice) => ({ ...slice, approach: "Use a direct export" })),
        },
        reason: "Make the implementation easier to read",
      }),
    );
    expect(revised.originalRequest).toBe(brief.originalRequest);
    expect(
      value(await readProductRecord(await workspace.state())).state.intentSnapshot,
    ).toHaveProperty("originalRequest", brief.originalRequest);
  });

  it("rejects a brief request that disagrees with its preserved snapshot even if its digest is updated", async () => {
    const state = await workspace.state();
    const record = value(await readProductRecord(state));
    const edited = { ...brief, originalRequest: "A rewritten request" };
    value(await state.files.writeTextAtomic(briefPath(state, brief.feature), stringify(edited)));
    value(
      await state.files.writeJson(productStatePath(state, brief.feature), {
        ...record.state,
        briefDigest: hashValue(edited),
      }),
    );
    const result = await readProductRecord(await workspace.state());
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID", message: expect.stringContaining("original request") },
    });
  });

  it("preserves migrated request bytes in product state without using history for later updates", async () => {
    await workspace.destroy();
    workspace = await TestWorkspace.create();
    await workspace.installFoundation();
    const feature = "007-historical";
    await workspace.withFeature(feature);
    const state = await workspace.state();
    const request = "  Keep the Exact User Wording.\nIncluding this line.  ";
    const legacy = value(await state.store.readIntent(feature));
    value(
      await state.store.writeIntent({
        ...legacy,
        sourceBrief: request,
        sourceBriefHash: sha256(request),
      }),
    );
    value(await runProductMigrate(await workspace.state(), { feature }));
    const migrated = value(await readProductRecord(await workspace.state(), { feature }));
    expect(migrated.brief.originalRequest).toBe(request);
    expect(migrated.state.intentSnapshot).toHaveProperty("originalRequest", request);
    await workspace.write(`.visp/features/${feature}/intent.json`, "{}\n");
    const revised = value(
      await updateProductBrief(await workspace.state(), {
        feature,
        brief: {
          ...migrated.brief,
          uncertainties: [...migrated.brief.uncertainties, "Which module owns the behavior?"],
        },
        reason: "Record the next relevant uncertainty",
      }),
    );
    expect(revised.originalRequest).toBe(request);
  });
});
