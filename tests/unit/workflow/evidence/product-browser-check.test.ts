import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vispError } from "../../../../src/core/errors.js";
import { sha256 } from "../../../../src/core/hash.js";
import { err, ok } from "../../../../src/core/result.js";
import { inspectStateLock, withStateLock } from "../../../../src/core/state-lock.js";
import * as probe from "../../../../src/testing/browser-capability.js";
import type { BrowserOperation } from "../../../../src/testing/browser-session.js";
import { BrowserUnavailableError } from "../../../../src/testing/chrome-transport.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { runProductDone, runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { productCheckSchema } from "../../../../src/workflow/product/model.js";
import * as store from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { pngHeader, type TestWorkspace } from "../../support/workspace.js";

const browser = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), sample: vi.fn() }));
vi.mock("../../../../src/testing/browser-session.js", () => ({ openBrowserSession: browser.open }));
const workspaces: TestWorkspace[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(probe, "probeBrowserCapability").mockResolvedValue();
  browser.close.mockResolvedValue(undefined);
  browser.sample.mockResolvedValue({ count: 1, visible: true, text: "Hit", textTruncated: false });
  browser.open.mockImplementation(async ({ directory, subjectDigest, viewport }) => {
    const operations: BrowserOperation[] = [];
    const record = (kind: BrowserOperation["kind"], description: string, result?: unknown) => {
      const id = `OP-${randomUUID()}`;
      operations.push({
        id,
        kind,
        description,
        completedAt: new Date().toISOString(),
        ...(result === undefined
          ? {}
          : { measurement: { json: JSON.stringify(result), truncated: false } }),
      });
      return id;
    };
    return {
      operations,
      navigate: async () => {
        record("navigate", "Navigate to application");
      },
      page: {
        keyboard: {
          press: async () => {
            record("keyboard", "Press Enter");
          },
        },
      },
      sample: browser.sample,
      record,
      close: browser.close,
      capture: async () => {
        const id = `CAP-${randomUUID()}`,
          path = join(directory, `${id}.png`);
        const bytes = pngHeader(640, 480);
        await writeFile(path, bytes);
        operations.push({
          id: `OP-${randomUUID()}`,
          kind: "capture",
          captureId: id,
          description: "Capture rendered application",
          completedAt: new Date().toISOString(),
        });
        return {
          id,
          path,
          sha256: sha256(bytes),
          subjectDigest,
          route: "http://localhost/",
          steps: [],
          viewport,
          createdAt: new Date().toISOString(),
          provenance: "runner-captured",
        };
      },
    };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const workspace of workspaces.splice(0)) await workspace.destroy();
});

async function fixture() {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const check = productCheckSchema.parse({
    id: "C001",
    environment: "browser",
    outcomes: ["O001"],
    command: {
      kind: "browser-journey",
      journey: {
        url: "http://localhost/",
        viewport: { width: 640, height: 480 },
        actions: [
          { kind: "key", key: "Enter" },
          { kind: "wait-for", selector: "#result", text: "Hit", timeoutMs: 1 },
        ],
      },
    },
  });
  const updated = await updateProductBrief(await workspace.state(), {
    brief: { ...brief, checks: [check] },
    reason: "Exercise a runner-owned browser check",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  expect(await runProductWork(await workspace.state())).toMatchObject({ ok: true });
  expect(probe.probeBrowserCapability).toHaveBeenCalledOnce();
  // These tests isolate product journeys; real capability startup is covered by the browser suite.
  return workspace;
}

describe("runner-owned browser product checks", () => {
  it("uses the shared journey engine and atomically publishes observed evidence with the execution", async () => {
    const workspace = await fixture();
    const result = await runProductVerify(await workspace.state());
    expect(result).toMatchObject({
      ok: true,
      value: {
        passed: true,
        executions: [
          {
            status: "passed",
            assertions: "runner-observed",
            provenance: "supervisor-executed",
            captureRunId: expect.stringMatching(/^CAPRUN-/),
            task: "T001",
          },
        ],
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    const record = await store.readProductRecord(await workspace.state());
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.executions).toEqual(result.value.executions);
    expect(record.value.state.captureRuns).toMatchObject([
      {
        id: result.value.executions[0]?.captureRunId,
        status: "completed",
        task: "T001",
        operations: [
          { kind: "navigate" },
          { kind: "capture" },
          { kind: "keyboard" },
          { kind: "observe" },
          { kind: "capture" },
        ],
      },
    ]);
    for (const capture of record.value.state.captures) {
      const parsed = capture as { path: string; sha256: string };
      expect(sha256(await readFile(join(workspace.root, parsed.path)))).toBe(parsed.sha256);
    }
    expect(browser.close).toHaveBeenCalledOnce();
    expect(await runProductDone(await workspace.state())).toMatchObject({
      ok: true,
      value: { closed: true, executions: [] },
    });
    expect(browser.open).toHaveBeenCalledOnce();
  });

  it.each([0, 2])(
    "fails unknown or ambiguous selectors (count=%s) and preserves terminal observations",
    async (count) => {
      const workspace = await fixture();
      browser.sample.mockResolvedValue({ count, visible: false, text: null });
      const result = await runProductDone(await workspace.state());
      expect(result).toMatchObject({
        ok: true,
        value: {
          closed: false,
          executions: [
            {
              status: "failed",
              assertions: "runner-observed",
              captureRunId: expect.any(String),
            },
          ],
          journeyFeedback: {
            runs: [{ status: "timed-out", message: expect.stringContaining("#result") }],
          },
        },
      });
      const record = await store.readProductRecord(await workspace.state());
      if (!record.ok) throw new Error(record.error.message);
      expect(record.value.state.captureRuns).toMatchObject([
        { status: "timed-out", failure: { kind: "behavior" } },
      ]);
      expect(record.value.state.slices.T001?.status).toBe("in-progress");
      expect(browser.close).toHaveBeenCalledOnce();
    },
  );

  it("rejects unknown task selection before opening a browser or changing evidence", async () => {
    const workspace = await fixture();
    const before = await store.readProductRecord(await workspace.state());
    expect(await runProductDone(await workspace.state(), { task: "T999" })).toMatchObject({
      ok: false,
      error: { code: "TASK_NOT_FOUND" },
    });
    expect(browser.open).not.toHaveBeenCalled();
    expect(await store.readProductRecord(await workspace.state())).toEqual(before);
    expect(
      productCheckSchema.safeParse({
        id: "C001",
        command: { kind: "browser-journey", task: "T999", journey: { url: "http://localhost/" } },
      }).success,
    ).toBe(false);
  });

  it("reuses images after an unrelated brief summary edit but reruns changed journey expectations", async () => {
    const workspace = await fixture();
    const verified = await runProductVerify(await workspace.state());
    if (!verified.ok) throw new Error(verified.error.message);
    const initial = await store.readProductRecord(await workspace.state());
    if (!initial.ok) throw new Error(initial.error.message);
    expect(
      await updateProductBrief(await workspace.state(), {
        brief: { ...initial.value.brief, goal: "Clarified product summary" },
        reason: "Clarify summary only",
      }),
    ).toMatchObject({ ok: true });
    expect(await runProductDone(await workspace.state())).toMatchObject({
      ok: true,
      value: { closed: true, executions: [] },
    });
    expect(browser.open).toHaveBeenCalledOnce();
    const record = await store.readProductRecord(await workspace.state());
    if (!record.ok) throw new Error(record.error.message);
    const revised = productCheckSchema.parse({
      ...record.value.brief.checks[0],
      command: {
        kind: "browser-journey",
        journey: {
          url: "http://localhost/",
          viewport: { width: 640, height: 480 },
          actions: [{ kind: "wait-for", selector: "#result", text: "Miss", timeoutMs: 1 }],
        },
      },
    });
    expect(
      await updateProductBrief(await workspace.state(), {
        brief: { ...record.value.brief, checks: [revised] },
        reason: "Change the runner observation contract",
      }),
    ).toMatchObject({ ok: true });
    expect(await runProductWork(await workspace.state())).toMatchObject({ ok: true });
    expect(await runProductDone(await workspace.state())).toMatchObject({
      ok: true,
      value: { closed: false, executions: [{ status: "failed" }] },
    });
    expect(browser.open).toHaveBeenCalledTimes(2);
  });

  it("discards captures if product source changes during a browser run", async () => {
    const workspace = await fixture();
    const original = browser.open.getMockImplementation();
    browser.open.mockImplementationOnce(async (options) => {
      await workspace.write("src/value.mjs", "export const value = 3;\n");
      return original?.(options);
    });
    expect(await runProductDone(await workspace.state())).toMatchObject({
      ok: true,
      value: {
        closed: false,
        executions: [
          {
            status: "environment-failed",
            output: expect.stringContaining("changed during capture"),
          },
        ],
      },
    });
    const record = await store.readProductRecord(await workspace.state());
    expect(record.ok && record.value.state.captureRuns).toEqual([]);
    expect(record.ok && record.value.state.captures).toEqual([]);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("keeps browser startup failures separate from behavior failures", async () => {
    const workspace = await fixture();
    browser.open.mockRejectedValueOnce(new BrowserUnavailableError("No installed browser"));
    expect(await runProductVerify(await workspace.state())).toMatchObject({
      ok: true,
      value: {
        passed: false,
        executions: [{ status: "environment-failed", output: "No installed browser" }],
      },
    });
    const record = await store.readProductRecord(await workspace.state());
    expect(record.ok && record.value.state.captureRuns).toEqual([]);
  });

  it("does not publish partial capture evidence if the final state transaction is refused", async () => {
    const workspace = await fixture();
    const before = await store.readProductRecord(await workspace.state());
    vi.spyOn(store, "saveProductState").mockResolvedValueOnce(
      err(vispError("STATE_BUSY", "Concurrent edit")),
    );
    expect(await runProductVerify(await workspace.state())).toMatchObject({
      ok: false,
      error: { code: "STATE_BUSY" },
    });
    expect(await store.readProductRecord(await workspace.state())).toEqual(before);
    if (!before.ok) throw new Error(before.error.message);
    const state = await workspace.state();
    const files = await readdir(
      join(state.paths.featureDir(before.value.brief.feature), "captures"),
    ).catch(() => []);
    expect(files).toEqual([]);
    expect(await inspectStateLock(workspace.root)).toEqual(ok({ state: "unlocked" }));
  });

  it("holds the existing mutation lock throughout the browser run", async () => {
    const workspace = await fixture();
    let entered = () => {},
      release = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = browser.open.getMockImplementation();
    browser.open.mockImplementationOnce(async (options) => {
      entered();
      await resume;
      return original?.(options);
    });
    const pending = runProductVerify(await workspace.state());
    await ready;
    try {
      expect(
        await withStateLock(workspace.root, async () => ok("other writer"), { timeoutMs: 0 }),
      ).toMatchObject({ ok: false, error: { code: "STATE_BUSY" } });
      const record = await store.readProductRecord(await workspace.state());
      expect(record.ok && record.value.state.captureRuns).toEqual([]);
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ ok: true, value: { passed: true } });
  });
});
