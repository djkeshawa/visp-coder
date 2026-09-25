import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import { createServer } from "../../../../src/mcp/server.js";
import { BrowserUnavailableError } from "../../../../src/testing/chrome-transport.js";
import { runProductCapture } from "../../../../src/workflow/evidence/product-capture.js";
import { runProductControl } from "../../../../src/workflow/evidence/product-control.js";
import {
  applicableProductCaptureRuns,
  productImageEvidenceGaps,
} from "../../../../src/workflow/product/assessment.js";
import {
  createProductFeature,
  updateProductBrief,
} from "../../../../src/workflow/product/brief.js";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import type { ProductBrief } from "../../../../src/workflow/product/model.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import {
  productContractDigest,
  productSourceDigest,
} from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { pngHeader, TestWorkspace } from "../../support/workspace.js";

const runtime = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../src/testing/browser-journey.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runBrowserJourney: runtime.run,
}));
let workspace: TestWorkspace;
let feature: string;
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function journeyRevision(brief: ProductBrief, revision: string): unknown {
  if (revision === "metadata")
    return { ...brief, uncertainties: ["Clarify a future optional documentation question"] };
  if (revision === "slice method")
    return {
      ...brief,
      slices: brief.slices.map((slice) =>
        slice.id === "T001"
          ? { ...slice, goal: "Launch through the revised interaction approach" }
          : slice,
      ),
    };
  return {
    ...brief,
    decisions: [
      {
        id: "D001",
        statement: "Change the approach",
        outcomes: [revision === "related decision" ? "O001" : "O002"],
      },
    ],
  };
}
beforeEach(async () => {
  runtime.run.mockReset();
  workspace = await TestWorkspace.create({ "src/app.ts": "export const n = 1;" });
  await workspace.installFoundation();
  workspace.commit("install product integration");
  const created = await createProductFeature(await workspace.state(), {
    goal: "Observable output",
  });
  if (!created.ok) throw new Error(created.error.message);
  feature = created.value.brief.feature;
  const updated = await updateProductBrief(await workspace.state(), {
    feature,
    brief: {
      ...created.value.brief,
      outcomes: [
        { id: "O001", kind: "experience", statement: "Launch is visible", reviewRequired: true },
      ],
      slices: [
        { id: "T001", goal: "Usable launch", outcomes: ["O001"], scope: { allowed: ["src/**"] } },
      ],
    },
  });
  if (!updated.ok) throw new Error(updated.error.message);
  runtime.run.mockImplementation(async (options: { directory: string; subjectDigest: string }) => {
    const path = join(options.directory, "CAP-real.png"),
      bytes = pngHeader(1280, 720);
    await writeFile(path, bytes);
    const afterPath = join(options.directory, "CAP-after.png");
    await writeFile(afterPath, bytes);
    const capture = {
      id: "CAP-real",
      path,
      sha256: sha256(bytes),
      subjectDigest: options.subjectDigest,
      route: "http://localhost:1234/",
      steps: ["Navigate", "Click launch"],
      viewport: { width: 1280, height: 720 },
      createdAt: "2026-01-01T00:00:00Z",
      provenance: "runner-captured",
    };
    return {
      status: "completed",
      captures: [capture, { ...capture, id: "CAP-after", path: afterPath }],
      operations: [
        {
          id: "capture-before",
          kind: "capture",
          captureId: "CAP-real",
          description: "Capture before",
          completedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "operation-one",
          kind: "pointer",
          description: "Click launch",
          completedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "capture-after",
          kind: "capture",
          captureId: "CAP-after",
          description: "Capture after",
          completedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
  });
});
afterEach(async () => {
  await workspace?.destroy();
});

describe("product-owned runtime operations", () => {
  it("keeps historical journey readers while rejecting unknown or unrelated owners and missing current contracts", async () => {
    const original = value(await readProductRecord(await workspace.state(), { feature }));
    value(
      await updateProductBrief(await workspace.state(), {
        feature,
        brief: {
          ...original.brief,
          outcomes: [
            ...original.brief.outcomes,
            { id: "O002", kind: "quality", statement: "Help is clear", priority: "should" },
          ],
          slices: [
            ...original.brief.slices,
            {
              id: "T002",
              goal: "Explain help",
              outcomes: ["O002"],
              scope: { allowed: ["README.md"] },
            },
          ],
        },
        reason: "Plan independent help content",
      }),
    );
    value(
      await runProductCapture(await workspace.state(), {
        feature,
        task: "T001",
        journey: { url: "http://localhost:1234/" },
      }),
    );
    const record = value(await readProductRecord(await workspace.state(), { feature }));
    const run = record.state.captureRuns[0];
    if (
      !run ||
      typeof run !== "object" ||
      !("subjectDigest" in run) ||
      typeof run.subjectDigest !== "string"
    )
      throw new Error("Expected the recorded run");
    expect(applicableProductCaptureRuns(record, run.subjectDigest, "O001")).toEqual([run]);
    const legacy = { ...run, version: 1, contractDigest: undefined, task: undefined };
    record.state.captureRuns = [legacy];
    expect(applicableProductCaptureRuns(record, run.subjectDigest, "O001")).toEqual([legacy]);
    const featureWide = {
      ...run,
      task: undefined,
      contractDigest: productContractDigest(record.brief),
    };
    record.state.captureRuns = [featureWide];
    expect(applicableProductCaptureRuns(record, run.subjectDigest, "O001")).toEqual([featureWide]);
    for (const candidate of [
      {},
      { ...run, task: "T999" },
      { ...run, subjectDigest: "b".repeat(64) },
      {
        ...run,
        task: "T002",
        contractDigest: productContractDigest(record.brief, record.brief.slices[1]),
      },
      { ...run, contractDigest: undefined },
    ]) {
      record.state.captureRuns = [candidate];
      expect(applicableProductCaptureRuns(record, run.subjectDigest, "O001")).toEqual([]);
    }
  });

  it.each([
    { owner: "slice", revision: "related decision", invalidated: true },
    { owner: "slice", revision: "unrelated decision", invalidated: false },
    { owner: "feature", revision: "related decision", invalidated: true },
    { owner: "feature", revision: "slice method", invalidated: true },
    { owner: "feature", revision: "metadata", invalidated: false },
  ])(
    "keeps $owner journey applicability selective after a $revision revision",
    async ({ owner, revision, invalidated }) => {
      const original = value(await readProductRecord(await workspace.state(), { feature }));
      const brief = value(
        await updateProductBrief(await workspace.state(), {
          feature,
          brief: {
            ...original.brief,
            outcomes: [
              ...original.brief.outcomes,
              { id: "O002", kind: "quality", statement: "Help is clear", priority: "should" },
            ],
            slices: [
              ...original.brief.slices,
              {
                id: "T002",
                goal: "Explain help",
                outcomes: ["O002"],
                scope: { allowed: ["README.md"] },
              },
            ],
          },
          reason: "Plan independent help content",
        }),
      );
      const captured = value(
        await runProductCapture(await workspace.state(), {
          feature,
          ...(owner === "slice" ? { task: "T001" } : {}),
          journey: { url: "http://localhost:1234/" },
        }),
      );
      value(
        await updateProductBrief(await workspace.state(), {
          feature,
          brief: journeyRevision(brief, revision),
          reason: "Revise the relevant implementation approach",
        }),
      );
      const bundle = value(
        await runProductReview(await workspace.state(), { feature, task: "T001" }),
      );
      expect(bundle.subjectDigest).toBe(captured.captures[0]?.subjectDigest);
      const reviewed = value(
        await runProductReview(await workspace.state(), {
          feature,
          task: "T001",
          subjectDigest: bundle.subjectDigest,
          assessments: [
            {
              outcome: "O001",
              status: "satisfied",
              summary: "Launch is visible before and after the input",
              evidence: captured.captures.map((capture) => capture.id),
            },
          ],
        }),
      );
      expect(reviewed.assessments[0]?.status).toBe(invalidated ? "unavailable" : "satisfied");
      const record = value(await readProductRecord(await workspace.state(), { feature }));
      // Recheck a persisted satisfied judgment as well, including one written before this fix.
      const assessment = record.state.reviews.at(-1)?.assessments[0];
      if (!assessment) throw new Error("Expected the saved judgment");
      assessment.status = "satisfied";
      const gaps = await productImageEvidenceGaps(
        await workspace.state(),
        record,
        bundle.subjectDigest,
        record.brief.slices[0],
      );
      expect(gaps.length).toBe(invalidated ? 1 : 0);
      value(await runProductWork(await workspace.state(), { feature, task: "T001" }));
      expect(
        value(await runProductDone(await workspace.state(), { feature, task: "T001" })).passed,
      ).toBe(!invalidated);
    },
  );

  it("publishes capture bytes, operation journal and state atomically without consuming a review cycle", async () => {
    const state = await workspace.state();
    const before = await productSourceDigest(state);
    const result = await runProductCapture(state, {
      feature,
      task: "T001",
      journey: { url: "http://localhost:1234/" },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.captures[0]?.path).toBe(`.visp/features/${feature}/captures/CAP-real.png`);
    expect(await readFile(join(workspace.root, result.value.captures[0]?.path ?? ""))).toEqual(
      pngHeader(1280, 720),
    );
    const record = await readProductRecord(state, { feature });
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.captures).toHaveLength(2);
    expect(record.value.state.reviews).toEqual([]);
    expect(await productSourceDigest(state)).toEqual(before);
    expect(await state.files.exists(state.paths.featureFile(feature, "spec.json"))).toEqual({
      ok: true,
      value: false,
    });
  });
  it("rejects unknown slices before opening a browser and refuses changed products before publication", async () => {
    const state = await workspace.state();
    expect(
      await runProductCapture(state, {
        feature,
        task: "T999",
        journey: { url: "http://localhost:1234/" },
      }),
    ).toMatchObject({ ok: false, error: { code: "TASK_NOT_FOUND" } });
    expect(runtime.run).not.toHaveBeenCalled();
    runtime.run.mockImplementationOnce(async () => {
      await workspace.write("src/app.ts", "export const n = 2;");
      return { status: "completed", captures: [], operations: [] };
    });
    expect(
      await runProductCapture(state, { feature, journey: { url: "http://localhost:1234/" } }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
    const record = await readProductRecord(state, { feature });
    expect(record.ok && record.value.state.captures).toEqual([]);
  });
  it("exposes capture and actual images through MCP and accepts a current review judgment", async () => {
    const server = createServer(workspace.root);
    const client = new Client({ name: "runtime-test", version: "1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, input: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: input })) as CallToolResult;
    try {
      const captured = await call("visp_capture", {
        feature,
        task: "T001",
        journey: { url: "http://localhost:1234/" },
      });
      expect(captured.isError, JSON.stringify(captured)).not.toBe(true);
      const statePath = join(workspace.root, `.visp/features/${feature}/product-state.json`);
      const beforeRead = await readFile(statePath, "utf8");
      const reviewed = await call("visp_observations", { feature, task: "T001", outcome: "O001" });
      expect((await call("visp_observations", { feature, outcome: "O999" })).isError).toBe(true);
      expect(await readFile(statePath, "utf8")).toBe(beforeRead);
      expect((await call("visp_observations", { feature, task: "T999" })).isError).toBe(true);
      expect(
        (
          await call("visp_capture", {
            feature,
            journey: { url: "http://localhost:1234/" },
            unsafe: true,
          })
        ).isError,
      ).toBe(true);
      expect(reviewed.isError, JSON.stringify(reviewed)).not.toBe(true);
      expect(
        reviewed.content.some(
          (block) =>
            block.type === "image" && block.data === pngHeader(1280, 720).toString("base64"),
        ),
      ).toBe(true);
      expect(JSON.stringify(reviewed.structuredContent)).not.toContain(
        pngHeader(1280, 720).toString("base64"),
      );
      const data = (
        reviewed.structuredContent as {
          data: { subjectDigest: string; images: Array<{ id: string }> };
        }
      ).data;
      const judgment = await call("visp_review", {
        feature,
        task: "T001",
        subjectDigest: data.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The launch state is visible in the actual capture",
            evidence: data.images.map((image) => image.id),
          },
        ],
      });
      expect(judgment.isError, JSON.stringify(judgment)).not.toBe(true);
      expect(
        (judgment.structuredContent as { data: { assessments: unknown[] } }).data.assessments,
      ).toMatchObject([{ outcome: "O001", status: "satisfied" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("stores supervised control results separately from product completion", async () => {
    await workspace.write(".visp/experiments/baseline/model.cjs", "module.exports=10;");
    await workspace.write(".visp/experiments/changed/model.cjs", "module.exports=1000;");
    await workspace.write(
      ".visp/experiments/verifier.cjs",
      "require('node:assert/strict').equal(require(process.cwd()+'/model.cjs'),10);",
    );
    const state = await workspace.state();
    const result = await runProductControl(state, {
      feature,
      task: "T001",
      experiment: {
        outcomes: ["O001"],
        baseline: { directory: ".visp/experiments/baseline", files: ["model.cjs"] },
        changed: { directory: ".visp/experiments/changed", files: ["model.cjs"] },
        verifierFile: ".visp/experiments/verifier.cjs",
        loadCommand: [process.execPath, "-e", "require('./model.cjs')"],
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.detected).toBe(true);
    const record = await readProductRecord(state, { feature });
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.controls).toHaveLength(1);
    expect(record.value.state.status).toBe("active");
    expect(record.value.state.reviews).toEqual([]);
  });
  it("rejects malformed journeys and unknown features before execution", async () => {
    const state = await workspace.state();
    expect(
      await runProductCapture(state, { feature, journey: { url: "data:text/html,invalid" } }),
    ).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(
      await runProductCapture(state, {
        feature: "999-absent",
        journey: { url: "http://localhost:1234/" },
      }),
    ).toMatchObject({ ok: false });
    expect(runtime.run).not.toHaveBeenCalled();
  });
  it("keeps missing browser capability explicit and never records fabricated capture failures", async () => {
    runtime.run.mockRejectedValueOnce(new BrowserUnavailableError("No installed browser"));
    expect(
      await runProductCapture(await workspace.state(), {
        feature,
        journey: { url: "http://localhost:1234/" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED", details: { gap: "browser-unavailable" } },
    });
    runtime.run.mockRejectedValueOnce(new Error("Page crashed"));
    expect(
      await runProductCapture(await workspace.state(), {
        feature,
        journey: { url: "http://localhost:1234/" },
      }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
    const record = await readProductRecord(await workspace.state(), { feature });
    expect(record.ok && record.value.state.captures).toEqual([]);
  });
  it("rejects colliding immutable capture destinations transactionally", async () => {
    const state = await workspace.state();
    const options = { feature, journey: { url: "http://localhost:1234/" } };
    expect((await runProductCapture(state, options)).ok).toBe(true);
    const prior = await readFile(
      join(workspace.root, `.visp/features/${feature}/product-state.json`),
      "utf8",
    );
    expect((await runProductCapture(await workspace.state(), options)).ok).toBe(false);
    expect(
      await readFile(join(workspace.root, `.visp/features/${feature}/product-state.json`), "utf8"),
    ).toBe(prior);
  });
  it("validates control selection and input confinement before executing any verifier", async () => {
    const state = await workspace.state();
    const experiment = {
      outcomes: ["O001"],
      baseline: { directory: ".visp/controls/base", files: ["model.cjs"] },
      changed: { directory: ".visp/controls/change", files: ["model.cjs"] },
      verifierFile: ".visp/controls/verify.cjs",
      loadCommand: [process.execPath, "-e", "require('./model.cjs')"],
    };
    expect(
      await runProductControl(state, { feature, experiment: { ...experiment, outcomes: [] } }),
    ).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(await runProductControl(state, { feature: "999-absent", experiment })).toMatchObject({
      ok: false,
    });
    expect(await runProductControl(state, { feature, task: "T999", experiment })).toMatchObject({
      ok: false,
      error: { code: "TASK_NOT_FOUND" },
    });
    expect(
      await runProductControl(state, {
        feature,
        experiment: { ...experiment, outcomes: ["O999"] },
      }),
    ).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(await runProductControl(state, { feature, experiment })).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_MISSING" },
    });
    expect(
      (
        await runProductControl(state, {
          feature,
          experiment: {
            ...experiment,
            baseline: { ...experiment.baseline, directory: "../../outside" },
          },
        })
      ).ok,
    ).toBe(false);
  });
  it("rejects a control that changes the active product during actual execution", async () => {
    await workspace.write(".visp/controls/base/model.cjs", "module.exports=10;");
    await workspace.write(".visp/controls/change/model.cjs", "module.exports=1000;");
    await workspace.write(
      ".visp/controls/verify.cjs",
      `require('node:fs').writeFileSync(${JSON.stringify(join(workspace.root, "src/app.ts"))},'export const n=999;');require('node:assert/strict').equal(require(process.cwd()+'/model.cjs'),10);`,
    );
    const experiment = {
      outcomes: ["O001"],
      baseline: { directory: ".visp/controls/base", files: ["model.cjs"] },
      changed: { directory: ".visp/controls/change", files: ["model.cjs"] },
      verifierFile: ".visp/controls/verify.cjs",
      loadCommand: [process.execPath, "-e", "require('./model.cjs')"],
    };
    expect(await runProductControl(await workspace.state(), { feature, experiment })).toMatchObject(
      { ok: false, error: { code: "EVIDENCE_FAILED" } },
    );
    const record = await readProductRecord(await workspace.state(), { feature });
    expect(record.ok && record.value.state.controls).toEqual([]);
    expect(
      await runProductControl(await workspace.state(), {
        feature,
        experiment: { ...experiment, changed: experiment.baseline },
      }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
  });
  it("keeps navigation-only capture and claimed satisfaction unresolved before UI completion", async () => {
    runtime.run.mockImplementationOnce(
      async (options: { directory: string; subjectDigest: string }) => {
        const path = join(options.directory, "CAP-navigation.png");
        const bytes = pngHeader(1280, 720);
        await writeFile(path, bytes);
        return {
          captures: [
            {
              id: "CAP-navigation",
              path,
              sha256: sha256(bytes),
              subjectDigest: options.subjectDigest,
              route: "http://localhost:1234/",
              steps: ["Navigate"],
              viewport: { width: 1280, height: 720 },
              createdAt: "2026-01-01T00:00:00Z",
              provenance: "runner-captured",
            },
          ],
          operations: [
            {
              id: "navigate",
              kind: "navigate",
              description: "Navigate",
              completedAt: "2026-01-01T00:00:00Z",
            },
            {
              id: "screenshot",
              kind: "capture",
              captureId: "CAP-navigation",
              description: "Initial state",
              completedAt: "2026-01-01T00:00:00Z",
            },
          ],
        };
      },
    );
    expect((await runProductWork(await workspace.state(), { feature, task: "T001" })).ok).toBe(
      true,
    );
    const captured = await runProductCapture(await workspace.state(), {
      feature,
      task: "T001",
      journey: { url: "http://localhost:1234/", actions: [] },
    });
    if (!captured.ok) throw new Error(captured.error.message);
    const reviewed = await runProductReview(await workspace.state(), {
      feature,
      task: "T001",
      subjectDigest: captured.value.captures[0]?.subjectDigest,
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "A screenshot exists; claimed controls work",
          evidence: ["CAP-navigation"],
        },
      ],
    });
    expect(reviewed).toMatchObject({
      ok: true,
      value: { assessments: [{ outcome: "O001", status: "unavailable" }] },
    });
    expect(JSON.stringify(reviewed)).toContain("interaction journey");
    expect(await runProductDone(await workspace.state(), { feature, task: "T001" })).toMatchObject({
      ok: true,
      value: { closed: false },
    });
  });
});
