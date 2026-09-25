import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { updateProductBrief } from "../../src/workflow/product/brief.js";
import { runProductDone } from "../../src/workflow/product/evidence.js";
import { productCaptureRunSchema } from "../../src/workflow/product/evidence-references.js";
import { createProductFeature } from "../../src/workflow/product/index.js";
import { readProductRecord } from "../../src/workflow/product/store.js";
import { runProductWork } from "../../src/workflow/product/work.js";
import { TestWorkspace } from "../unit/support/workspace.js";

const fixture = new URL("../fixtures/product-quality/bramble-brigade.html", import.meta.url);
const sourceHash = "8b06e6427c2a8f3234724c2c47c46923d58ae43d41d638b9f5bb0b8eb86b1e31";

// Deliberately weak: syntax and source presence cannot establish a working interaction.
const staticCheck = String.raw`
  const assert = require('node:assert/strict');
  const html = require('node:fs').readFileSync('index.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'Game script exists');
  new Function(script);
  for (const token of ['ArrowLeft', 'launchBird', 'Emberbird airborne']) {
    assert.ok(script.includes(token), token + ' exists');
  }
  console.log('Static syntax and keyboard source checks passed');
`;

async function authorizeKeyboardCheck(workspace: TestWorkspace) {
  await workspace.installFoundation();
  workspace.commit("install foundation");
  const started = await createProductFeature(await workspace.state(), {
    goal: "Launch the aimed bird with the keyboard",
  });
  if (!started.ok) throw new Error(started.error.message);
  const updated = await updateProductBrief(await workspace.state(), {
    brief: {
      ...started.value.brief,
      outcomes: [
        {
          id: "O001",
          kind: "functional",
          statement: "After ArrowLeft aims, Space launches the bird",
          priority: "must",
          provenance: "user-stated",
        },
      ],
      checks: [
        {
          id: "C001",
          command: [process.execPath, "-e", staticCheck],
          outcomes: ["O001"],
          files: ["index.html"],
          environment: "node",
        },
        {
          id: "C002",
          command: {
            kind: "browser-journey",
            journey: {
              url: pathToFileURL(join(workspace.root, "index.html")).href,
              viewport: { width: 1280, height: 900 },
              actions: [
                { kind: "key", key: "ArrowLeft" },
                { kind: "key", key: "Space" },
                {
                  kind: "wait-for",
                  selector: "#game-status",
                  text: "Emberbird airborne",
                  timeoutMs: 300,
                },
              ],
            },
          },
          outcomes: ["O001"],
          files: ["index.html"],
          environment: "browser",
        },
      ],
      slices: [
        {
          id: "T001",
          goal: "Aim and launch with native keyboard input",
          outcomes: ["O001"],
          scope: { allowed: ["index.html"], expected: [], forbidden: [] },
          checks: ["C001", "C002"],
        },
      ],
    },
    reason: "Check the actual keyboard transition alongside static source checks",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  const worked = await runProductWork(await workspace.state(), { task: "T001" });
  if (!worked.ok) throw new Error(worked.error.message);
}

it("refuses slice closure when real keyboard behavior fails despite passing static checks", async () => {
  const html = await readFile(fixture);
  expect(sha256(html)).toBe(sourceHash);
  const workspace = await TestWorkspace.create({ "index.html": html });
  try {
    await authorizeKeyboardCheck(workspace);
    const result = await runProductDone(await workspace.state(), { task: "T001" });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toMatchObject({ passed: false, closed: false });
    expect(result.value.executions).toMatchObject([
      {
        check: "C001",
        status: "passed",
        provenance: "supervisor-executed",
        output: expect.stringContaining("Static syntax and keyboard source checks passed"),
      },
      {
        check: "C002",
        status: "failed",
        provenance: "supervisor-executed",
        assertions: "runner-observed",
        captureRunId: expect.stringMatching(/^CAPRUN-/),
      },
    ]);

    const record = await readProductRecord(await workspace.state());
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.slices.T001?.status).toBe("in-progress");
    expect(record.value.state.executions).toEqual(result.value.executions);
    expect(record.value.state.reviews).toEqual([]);
    expect(record.value.state.captureRuns).toHaveLength(1);
    const run = productCaptureRunSchema.parse(record.value.state.captureRuns[0]);
    expect(run).toMatchObject({
      id: result.value.executions[1]?.captureRunId,
      version: 2,
      provenance: "runner-executed",
      task: "T001",
      status: "timed-out",
      failure: { kind: "behavior", operationId: expect.any(String) },
    });
    expect(run.operations.filter((operation) => operation.kind === "keyboard")).toHaveLength(2);
    const observation = run.operations.find(
      (operation) => operation.id === run.failure?.operationId,
    );
    expect(observation?.kind).toBe("observe");
    const terminal = JSON.parse(observation?.measurement?.json ?? "null");
    expect(terminal).toMatchObject({
      expected: { selector: "#game-status", text: "Emberbird airborne" },
      actual: { count: 1, text: "Aim set · press Space to launch" },
      matched: false,
    });
    expect(result.value.journeyFeedback?.runs).toMatchObject([
      {
        runId: run.id,
        status: "timed-out",
        failureOperationId: observation?.id,
        terminalMeasurement: observation?.measurement,
      },
    ]);
    expect(run.captures.length).toBeGreaterThan(0);
    for (const capture of run.captures) {
      expect(capture.provenance).toBe("runner-captured");
      expect(sha256(await readFile(join(workspace.root, capture.path)))).toBe(capture.sha256);
    }
    const runPath = join(
      workspace.root,
      ".visp/features",
      record.value.brief.feature,
      "captures",
      `run-${run.id}.json`,
    );
    expect(productCaptureRunSchema.parse(JSON.parse(await readFile(runPath, "utf8")))).toEqual(run);
    expect(await readFile(join(workspace.root, "index.html"))).toEqual(html);
    expect(sha256(await readFile(fixture))).toBe(sourceHash);
  } finally {
    await workspace.destroy();
  }
}, 30_000);
