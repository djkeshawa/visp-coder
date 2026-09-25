import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vispError } from "../../../../src/core/errors.js";
import { sha256 } from "../../../../src/core/hash.js";
import { err } from "../../../../src/core/result.js";
import { BrowserUnavailableError } from "../../../../src/testing/chrome-transport.js";
import { runProductCapture } from "../../../../src/workflow/evidence/product-capture.js";
import { runProductControl } from "../../../../src/workflow/evidence/product-control.js";
import {
  inspectReviewImages,
  type ProductReviewCapture,
} from "../../../../src/workflow/evidence/product-review.js";
import * as store from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { pngHeader, type TestWorkspace } from "../../support/workspace.js";

const browser = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../src/testing/browser-journey.js", async (original) => ({
  ...(await original<object>()),
  runBrowserJourney: browser.run,
}));

let workspace: TestWorkspace;
let feature: string;
beforeEach(async () => {
  browser.run.mockReset();
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  feature = fixture.brief.feature;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace?.destroy();
});
const journey = { url: "http://127.0.0.1:3000/" };
async function currentState() {
  const record = await store.readProductRecord(await workspace.state(), { feature });
  if (!record.ok) throw new Error(record.error.message);
  return record.value.state;
}

describe("execution adapter boundaries", () => {
  it("rejects malformed journeys and nonexistent features before opening the runtime", async () => {
    const state = await workspace.state();
    expect(
      await runProductCapture(state, { feature, journey: { url: "data:text/html,invalid" } }),
    ).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(await runProductCapture(state, { feature: "999-missing", journey })).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_MISSING" },
    });
    expect(browser.run).not.toHaveBeenCalled();
  });

  it.each([
    [new BrowserUnavailableError("No installed Chrome is available"), "UNSUPPORTED"],
    [new Error("Page closed before capture"), "EVIDENCE_FAILED"],
  ])(
    "keeps runtime failure as an explicit gap without capture publication",
    async (error, code) => {
      browser.run.mockRejectedValueOnce(error);
      const before = await currentState();
      expect(await runProductCapture(await workspace.state(), { feature, journey })).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(await currentState()).toEqual(before);
    },
  );

  it("does not launch a browser when repository identity cannot be read", async () => {
    const state = await workspace.state();
    vi.spyOn(state.files, "readBytesIfExists").mockResolvedValueOnce(
      err(vispError("IO_ERROR", "Denied source read")),
    );
    expect(await runProductCapture(state, { feature, journey })).toMatchObject({
      ok: false,
      error: { code: "IO_ERROR" },
    });
    expect(browser.run).not.toHaveBeenCalled();
  });

  it("does not publish partial captures when the state transaction fails", async () => {
    const bytes = pngHeader(640, 480);
    browser.run.mockImplementationOnce(async ({ directory, subjectDigest }) => {
      const path = join(directory, "frame.png");
      await writeFile(path, bytes);
      return {
        status: "completed",
        captures: [
          {
            id: "CAP-no-partial",
            path,
            sha256: sha256(bytes),
            subjectDigest,
            route: journey.url,
            steps: ["Navigate"],
            viewport: { width: 640, height: 480 },
            createdAt: new Date().toISOString(),
            provenance: "runner-captured",
          },
        ],
        operations: [],
      };
    });
    const before = await currentState();
    vi.spyOn(store, "saveProductState").mockResolvedValueOnce(
      err(vispError("IO_ERROR", "Concurrent state edit")),
    );
    expect(await runProductCapture(await workspace.state(), { feature, journey })).toMatchObject({
      ok: false,
      error: { code: "IO_ERROR" },
    });
    expect(await currentState()).toEqual(before);
    expect(
      await (await workspace.state()).files.exists(
        `.visp/features/${feature}/captures/CAP-no-partial.png`,
      ),
    ).toEqual({ ok: true, value: false });
  });

  async function experiment(
    verifier = "require('node:assert/strict').equal(require(process.cwd()+'/model.cjs'),1);",
  ) {
    await workspace.write(".visp/experiments/base/model.cjs", "module.exports=1;");
    await workspace.write(".visp/experiments/changed/model.cjs", "module.exports=2;");
    await workspace.write(".visp/experiments/verify.cjs", verifier);
    return {
      outcomes: ["O001"],
      baseline: { directory: ".visp/experiments/base", files: ["model.cjs"] },
      changed: { directory: ".visp/experiments/changed", files: ["model.cjs"] },
      verifierFile: ".visp/experiments/verify.cjs",
      loadCommand: [process.execPath, "-e", "require('./model.cjs')"],
    };
  }

  it("rejects invalid selection, unknown outcomes and missing subjects without recording controls", async () => {
    const input = await experiment();
    const state = await workspace.state();
    for (const options of [
      { feature, experiment: {} },
      { feature: "999-missing", experiment: input },
      { feature, task: "T999", experiment: input },
      { feature, experiment: { ...input, outcomes: ["O999"] } },
      {
        feature,
        experiment: { ...input, baseline: { ...input.baseline, directory: ".visp/missing" } },
      },
      {
        feature,
        experiment: { ...input, baseline: { ...input.baseline, directory: "../outside" } },
      },
      { feature, experiment: { ...input, verifierFile: ".visp/experiments/missing.cjs" } },
    ])
      expect((await runProductControl(state, options)).ok).toBe(false);
    expect((await currentState()).controls).toEqual([]);
  });

  it("refuses to give control credit to a missing executable or a subject changed during execution", async () => {
    const input = await experiment();
    expect(
      (
        await runProductControl(await workspace.state(), {
          feature,
          experiment: { ...input, executable: "visp-program-does-not-exist" },
        })
      ).ok,
    ).toBe(false);
    const drift = await experiment(
      `require('node:fs').writeFileSync(${JSON.stringify(join(workspace.root, "src/value.mjs"))}, 'export const value=99;'); require('node:assert/strict').equal(require(process.cwd()+'/model.cjs'),1);`,
    );
    expect(
      await runProductControl(await workspace.state(), { feature, experiment: drift }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
    expect((await currentState()).controls).toEqual([]);
  });
});

describe("image delivery refusal counterchecks", () => {
  const bytes = pngHeader(640, 480);
  const capture: ProductReviewCapture = {
    id: "CAP-one",
    path: ".visp/one.png",
    sha256: sha256(bytes),
    subjectDigest: "current",
    route: "/User/Alice",
    steps: ["Load page"],
    viewport: { width: 640, height: 480 },
    createdAt: "2026-09-07T00:00:00Z",
    provenance: "agent-supplied",
  };
  it.each([
    { ...capture, route: " " },
    { ...capture, viewport: { width: 0, height: 480 } },
    { ...capture, viewport: { width: 640, height: -1 } },
  ])("refuses unusable capture metadata", async (item) => {
    const result = await inspectReviewImages({
      subjectDigest: "current",
      captures: [item],
      readBytes: async () => bytes,
    });
    expect(result.images).toEqual([]);
    expect(result.gaps.length).toBeGreaterThan(0);
  });
  it("keeps read failures, oversized images and invalid content explicit", async () => {
    for (const readBytes of [
      async () => {
        throw new Error("unavailable");
      },
      async () => Buffer.alloc(4 * 1024 * 1024 + 1),
      async () => Buffer.from("not an image"),
    ]) {
      const result = await inspectReviewImages({
        subjectDigest: "current",
        captures: [capture],
        readBytes,
      });
      expect(result.images).toEqual([]);
    }
    const invalid = Buffer.from("not an image");
    expect(
      (
        await inspectReviewImages({
          subjectDigest: "current",
          captures: [{ ...capture, sha256: sha256(invalid) }],
          readBytes: async () => invalid,
        })
      ).images,
    ).toEqual([]);
  });
});
