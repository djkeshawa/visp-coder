import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import { sha256 } from "../../../../src/core/hash.js";
import { runProductCapture } from "../../../../src/workflow/evidence/product-capture.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import { runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { runProductNext } from "../../../../src/workflow/product/status.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { pngHeader } from "../../support/workspace.js";

const browser = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../src/testing/browser-journey.js", async (original) => ({
  ...(await original<object>()),
  runBrowserJourney: browser.run,
}));

const config = balancedCritic("codex");
if (!config) throw new Error("Missing critic preset");

let setup: Awaited<ReturnType<typeof productWorkspace>>;
beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
  browser.run.mockReset();
  browser.run.mockImplementation(async ({ directory, subjectDigest }) => {
    const bytes = pngHeader(640, 480);
    const path = `${directory}/state.png`;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, bytes));
    return {
      status: "completed",
      captures: [
        {
          id: "CAP-state",
          path,
          sha256: sha256(bytes),
          subjectDigest,
          route: "http://127.0.0.1:3000/",
          steps: ["Navigate"],
          viewport: { width: 640, height: 480 },
          createdAt: new Date().toISOString(),
          provenance: "runner-captured",
        },
      ],
      operations: [],
    };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (setup) await setup.workspace.destroy();
});

async function configureCritic() {
  const result = await runProductCritic(await setup.workspace.state(), {
    task: "T001",
    operation: "configure",
    config: { ...config, transport: "native" },
  });
  if (!result.ok) throw new Error(result.error.message);
}

it("adds the current native critic action to work after observations exist", async () => {
  const initial = await runProductWork(await setup.workspace.state(), { task: "T001" });
  if (!initial.ok) throw new Error(initial.error.message);
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  await configureCritic();
  expect(await runProductVerify(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { passed: true },
  });

  const work = await runProductWork(await setup.workspace.state(), { task: "T001" });
  expect(work).toMatchObject({
    ok: true,
    value: {
      criticAdvice: {
        status: "suggested",
        command: expect.stringContaining("visp critic --feature"),
      },
    },
  });
  expect(work.ok && work.value.criticAdvice?.command).toContain("--preflight");
});

it("routes a committed capture to native preflight and returns a stable replay command", async () => {
  const initial = await runProductWork(await setup.workspace.state(), { task: "T001" });
  if (!initial.ok) throw new Error(initial.error.message);
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  await configureCritic();

  const capture = await runProductCapture(await setup.workspace.state(), {
    task: "T001",
    journey: { url: "http://127.0.0.1:3000/" },
  });
  expect(capture).toMatchObject({
    ok: true,
    value: {
      status: "completed",
      next: {
        criticAdvice: {
          status: "suggested",
          command: expect.stringContaining("--preflight"),
        },
      },
      nextCommand: expect.stringContaining("--preflight"),
      replayCommand: expect.stringContaining("--replay="),
    },
  });
  expect(browser.run).toHaveBeenCalledOnce();

  await setup.workspace.write("src/value.mjs", "export const value = 3;\n");
  const stale = await runProductNext(await setup.workspace.state(), { task: "T001" });
  expect(stale).toMatchObject({ ok: true });
  expect(stale.ok && stale.value.criticAdvice?.command).toBeUndefined();
});

it("keeps failed capture routing on repair while preserving replay", async () => {
  browser.run.mockImplementationOnce(async ({ directory, subjectDigest }) => {
    const bytes = pngHeader(640, 480);
    const path = `${directory}/failed.png`;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, bytes));
    return {
      status: "timed-out",
      failure: { kind: "behavior", message: "Launch remained enabled", actionIndex: 0 },
      captures: [
        {
          id: "CAP-failed",
          path,
          sha256: sha256(bytes),
          subjectDigest,
          route: "http://127.0.0.1:3000/",
          steps: ["Navigate"],
          viewport: { width: 640, height: 480 },
          createdAt: new Date().toISOString(),
          provenance: "runner-captured",
        },
      ],
      operations: [],
    };
  });
  const initial = await runProductWork(await setup.workspace.state(), { task: "T001" });
  if (!initial.ok) throw new Error(initial.error.message);

  const capture = await runProductCapture(await setup.workspace.state(), {
    task: "T001",
    journey: { url: "http://127.0.0.1:3000/" },
  });
  expect(capture).toMatchObject({
    ok: true,
    value: {
      status: "timed-out",
      next: { action: "fix", command: expect.stringContaining("visp review") },
      nextCommand: expect.stringContaining("visp review"),
      replayCommand: expect.stringContaining("--replay="),
    },
  });
});
