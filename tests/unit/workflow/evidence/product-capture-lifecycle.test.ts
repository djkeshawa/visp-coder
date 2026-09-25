import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vispError } from "../../../../src/core/errors.js";
import { hashValue, sha256 } from "../../../../src/core/hash.js";
import { err, ok } from "../../../../src/core/result.js";
import { BrowserSecurityError } from "../../../../src/testing/browser-files.js";
import { runProductCapture } from "../../../../src/workflow/evidence/product-capture.js";
import { prepareProductCapture } from "../../../../src/workflow/evidence/product-capture-execution.js";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import * as store from "../../../../src/workflow/product/store.js";
import * as subject from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { pngHeader, type TestWorkspace } from "../../support/workspace.js";

const lifecycle = vi.hoisted(() => ({
  run: vi.fn(),
  directory: "",
  reading: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  cleanupStarted: false,
}));
vi.mock("../../../../src/testing/browser-journey.js", async (original) => ({
  ...(await original<object>()),
  runBrowserJourney: lifecycle.run,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (
        lifecycle.directory &&
        String(args[0]).startsWith(`${lifecycle.directory}/`) &&
        lifecycle.release
      ) {
        lifecycle.reading?.();
        await lifecycle.release;
      }
      return fs.readFile(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === lifecycle.directory) lifecycle.cleanupStarted = true;
      return fs.rm(...args);
    },
  };
});

let workspace: TestWorkspace;
let feature: string;
beforeEach(async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  feature = fixture.brief.feature;
  lifecycle.directory = "";
  lifecycle.cleanupStarted = false;
  lifecycle.reading = undefined;
  lifecycle.release = undefined;
  lifecycle.run.mockReset();
  lifecycle.run.mockImplementation(async ({ directory, subjectDigest }) => {
    lifecycle.directory = directory;
    const captures = [];
    for (const id of ["CAP-before", "CAP-after", "CAP-result"]) {
      const path = join(directory, `${id}.png`);
      const bytes = pngHeader(640, 480);
      await writeFile(path, bytes);
      captures.push({
        id,
        path,
        sha256: sha256(bytes),
        subjectDigest,
        route: "http://127.0.0.1:3000/",
        steps: ["Navigate", "Press Enter"],
        viewport: { width: 640, height: 480 },
        createdAt: new Date().toISOString(),
        provenance: "runner-captured",
      });
    }
    return { status: "completed", captures, operations: [] };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.destroy();
});

describe("capture publication lifecycle", () => {
  it.each([
    { journey: { url: "javascript:alert(1)" }, task: "T001", code: "CONFIG_INVALID" },
    { journey: { url: "http://127.0.0.1:3000/" }, task: "T999", code: "TASK_NOT_FOUND" },
  ])("rejects shared-helper input before browser startup ($code)", async ({ code, ...options }) => {
    const state = await workspace.state();
    const before = await store.readProductRecord(state, { feature });
    if (!before.ok) throw new Error(before.error.message);
    const snapshot = vi.spyOn(subject, "productSourceDigest");
    expect(await prepareProductCapture(state, before.value, options)).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
    expect(await store.readProductRecord(state, { feature })).toEqual(before);
  });

  it.each(["before", "after"])(
    "preserves state when source identity fails %s browser execution",
    async (stage) => {
      const state = await workspace.state();
      const before = await readFile(store.productStatePath(state, feature), "utf8");
      const snapshot = vi.spyOn(subject, "productSourceDigest");
      if (stage === "after")
        snapshot.mockResolvedValueOnce(ok("a".repeat(64))).mockResolvedValueOnce(ok("environment"));
      snapshot.mockResolvedValueOnce(err(vispError("IO_ERROR", "Cannot inspect product source")));
      const publish = vi.spyOn(store, "saveProductState");
      expect(
        await runProductCapture(state, { feature, journey: { url: "http://127.0.0.1:3000/" } }),
      ).toMatchObject({
        ok: false,
        error: { code: "IO_ERROR", message: "Cannot inspect product source" },
      });
      expect(publish).not.toHaveBeenCalled();
      expect(await readFile(store.productStatePath(state, feature), "utf8")).toBe(before);
      if (stage === "before") expect(lifecycle.run).not.toHaveBeenCalled();
      else {
        expect(lifecycle.run).toHaveBeenCalledOnce();
        expect(lifecycle.cleanupStarted).toBe(true);
        await expect(access(lifecycle.directory)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("discards temporary captures across a browser security rejection", async () => {
    const state = await workspace.state();
    const before = await readFile(store.productStatePath(state, feature), "utf8");
    const run = lifecycle.run.getMockImplementation();
    lifecycle.run.mockImplementationOnce(async (options) => {
      await run?.(options);
      throw new BrowserSecurityError("A browser request escaped the allowed project");
    });
    expect(
      await runProductCapture(state, { feature, journey: { url: "http://127.0.0.1:3000/" } }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "UNSUPPORTED",
        details: { gap: "browser-security", reviewStatus: "unavailable" },
      },
    });
    expect(await readFile(store.productStatePath(state, feature), "utf8")).toBe(before);
    await expect(access(join(state.paths.featureDir(feature), "captures"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(lifecycle.cleanupStarted).toBe(true);
    await expect(access(lifecycle.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish a partial set when a temporary capture disappears before buffering", async () => {
    const state = await workspace.state();
    const before = await readFile(store.productStatePath(state, feature), "utf8");
    const run = lifecycle.run.getMockImplementation();
    lifecycle.run.mockImplementationOnce(async (options) => {
      const result = await run?.(options);
      await rm(join(options.directory, "CAP-after.png"));
      return result;
    });
    const publish = vi.spyOn(store, "saveProductState");
    expect(
      await runProductCapture(state, { feature, journey: { url: "http://127.0.0.1:3000/" } }),
    ).toMatchObject({
      ok: false,
      error: { code: "EVIDENCE_FAILED", message: expect.stringContaining("CAP-after.png") },
    });
    expect(publish).not.toHaveBeenCalled();
    expect(await readFile(store.productStatePath(state, feature), "utf8")).toBe(before);
    await expect(access(join(state.paths.featureDir(feature), "captures"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(lifecycle.cleanupStarted).toBe(true);
    await expect(access(lifecycle.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically preserves actual failed observations without relabeling the journey complete", async () => {
    const original = lifecycle.run.getMockImplementation();
    lifecycle.run.mockImplementationOnce(async (options) => {
      const result = await original?.(options);
      return {
        ...result,
        status: "timed-out",
        failure: {
          kind: "behavior",
          message: "Launch remained enabled",
          operationId: "observed-disabled",
          actionIndex: 2,
        },
        operations: [
          {
            id: "observed-disabled",
            kind: "observe",
            completedAt: new Date().toISOString(),
            description: "Observe launch",
            measurement: {
              json: JSON.stringify({
                expected: { enabled: false },
                actual: { enabled: true },
                matched: false,
              }),
              truncated: false,
            },
          },
        ],
      };
    });
    const state = await workspace.state();
    const result = await runProductCapture(state, {
      feature,
      task: "T001",
      journey: { url: "http://127.0.0.1:3000/" },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { status: "timed-out", failure: { kind: "behavior" }, captures: expect.any(Array) },
    });
    const record = await store.readProductRecord(state, { feature });
    if (!record.ok || !result.ok) throw new Error("Expected persisted observations");
    expect(record.value.state.captureRuns).toMatchObject([
      {
        version: 2,
        status: "timed-out",
        id: result.value.runId,
        contractDigest: expect.any(String),
        journeyDigest: expect.any(String),
        journeyKey: expect.any(String),
      },
    ]);
    const bytes = await readFile(
      join(state.paths.featureDir(feature), "captures", `run-${result.value.runId}.json`),
      "utf8",
    );
    expect(JSON.parse(bytes)).toEqual(record.value.state.captureRuns[0]);
    expect(record.value.state.reviews).toEqual([]);
    const work = await runProductWork(await workspace.state(), { feature, task: "T001" });
    const done = await runProductDone(await workspace.state(), { feature, task: "T001" });
    for (const delivery of [work, done]) {
      if (!delivery.ok) throw new Error(delivery.error.message);
      expect(delivery.value.journeyFeedback).toMatchObject({
        omitted: 0,
        runs: [
          {
            runId: result.value.runId,
            status: "timed-out",
            message: "Launch remained enabled",
            failureOperationId: "observed-disabled",
            captureIds: ["CAP-before", "CAP-after", "CAP-result"],
          },
        ],
      });
      const measurement = delivery.value.journeyFeedback?.runs[0]?.terminalMeasurement;
      expect(measurement?.truncated).toBe(false);
      expect(JSON.parse(measurement?.json ?? "null")).toEqual({
        expected: { enabled: false },
        actual: { enabled: true },
        matched: false,
      });
    }
    expect(done).toMatchObject({ ok: true, value: { passed: false, closed: false } });
    expect(work.ok && work.value).not.toHaveProperty("reviewAgenda");
  });
  it("retains temporary images until all three captures are published", async () => {
    let release = () => {};
    lifecycle.release = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      lifecycle.reading = resolve;
    });
    const state = await workspace.state();
    const pending = runProductCapture(state, {
      feature,
      journey: { url: "http://127.0.0.1:3000/" },
    }).catch((cause: unknown) => cause);
    await reading;
    // Let finally run, if publication was returned without being awaited.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const cleanedBeforeReading = lifecycle.cleanupStarted;
    release();
    const result = await pending;
    expect(cleanedBeforeReading).toBe(false);
    expect(result).toMatchObject({ ok: true, value: { captures: expect.any(Array) } });
    const record = await store.readProductRecord(state, { feature });
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.captures).toHaveLength(3);
    for (const id of ["CAP-before", "CAP-after", "CAP-result"])
      expect(
        await readFile(join(state.paths.featureDir(feature), "captures", `${id}.png`)),
      ).toEqual(pngHeader(640, 480));
    expect(lifecycle.cleanupStarted).toBe(true);
    await expect(access(lifecycle.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes partial runtime failures as diagnostics that remain unresolved", async () => {
    const original = lifecycle.run.getMockImplementation();
    lifecycle.run.mockImplementationOnce(async (options) => ({
      ...(await original?.(options)),
      status: "timed-out",
      failure: {
        kind: "environment",
        message: "Input.dispatchMouseEvent timed out",
        actionIndex: 0,
      },
    }));
    const state = await workspace.state();
    const result = await runProductCapture(state, {
      feature,
      task: "T001",
      journey: { url: "http://127.0.0.1:3000/" },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { status: "timed-out", failure: { kind: "environment" } },
    });
    const record = await store.readProductRecord(state, { feature });
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.captureRuns).toMatchObject([
      {
        version: 2,
        status: "timed-out",
        captures: expect.any(Array),
        failure: { kind: "environment" },
      },
    ]);
    const work = await runProductWork(await workspace.state(), { feature, task: "T001" });
    const done = await runProductDone(await workspace.state(), { feature, task: "T001" });
    expect(work).toMatchObject({
      ok: true,
      value: { journeyFailures: ["Browser timed-out: Input.dispatchMouseEvent timed out"] },
    });
    expect(done).toMatchObject({
      ok: true,
      value: {
        closed: false,
        passed: false,
        gaps: expect.arrayContaining(["Browser timed-out: Input.dispatchMouseEvent timed out"]),
      },
    });
  });

  it.each(["returned failure", "thrown failure"])(
    "waits for a delayed transaction %s before cleanup and preserves state",
    async (failure) => {
      const state = await workspace.state();
      const before = await readFile(store.productStatePath(state, feature), "utf8");
      let release = () => {};
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let publishing = () => {};
      const started = new Promise<void>((resolve) => {
        publishing = resolve;
      });
      vi.spyOn(store, "saveProductState").mockImplementationOnce(async () => {
        publishing();
        await barrier;
        if (failure === "thrown failure") throw new Error("Capture transaction unavailable");
        return err(vispError("IO_ERROR", "Capture transaction unavailable"));
      });
      const pending = runProductCapture(state, {
        feature,
        journey: { url: "http://127.0.0.1:3000/" },
      }).catch((cause: unknown) => cause);
      await started;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const cleanedBeforePublication = lifecycle.cleanupStarted;
      release();
      const result = await pending;
      expect(cleanedBeforePublication).toBe(false);
      expect(result).toMatchObject({
        ok: false,
        error: { code: failure === "thrown failure" ? "EVIDENCE_FAILED" : "IO_ERROR" },
      });
      expect(await readFile(store.productStatePath(state, feature), "utf8")).toBe(before);
      await expect(access(join(state.paths.featureDir(feature), "captures"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
      expect(lifecycle.cleanupStarted).toBe(true);
      await expect(access(lifecycle.directory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

it("rejects unknown and ambiguous replay inputs without starting a browser", async () => {
  const state = await workspace.state();
  for (const input of [
    { replay: "missing" },
    {},
    { replay: "missing", journey: { url: "http://127.0.0.1/" } },
  ]) {
    expect(await runProductCapture(state, { feature, ...input })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
  }
  expect(lifecycle.run).not.toHaveBeenCalled();
});

it("retains legacy bytes and refuses altered, duplicate or differently scoped replay records", async () => {
  const state = await workspace.state();
  const path = store.productStatePath(state, feature);
  const original = JSON.parse(await readFile(path, "utf8"));
  const journey = { url: "http://127.0.0.1:3000/", actions: [] };
  for (const captureRuns of [
    [{ id: "legacy", provenance: "runner-executed" }],
    [{ id: "legacy", provenance: "runner-executed", journey, journeyDigest: "altered" }],
    [{ id: "legacy" }, { id: "legacy" }],
  ]) {
    const bytes = JSON.stringify({ ...original, captureRuns });
    await writeFile(path, bytes);
    expect(await runProductCapture(state, { feature, replay: "legacy" })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(await readFile(path, "utf8")).toBe(bytes);
  }
  const scoped = JSON.stringify({
    ...original,
    captureRuns: [
      {
        id: "scoped",
        provenance: "runner-executed",
        task: "T002",
        journey,
        journeyDigest: hashValue(journey),
      },
    ],
  });
  await writeFile(path, scoped);
  expect(await runProductCapture(state, { feature, task: "T001", replay: "scoped" })).toMatchObject(
    { ok: false, error: { code: "TASK_NOT_FOUND" } },
  );
  expect(await readFile(path, "utf8")).toBe(scoped);
  expect(lifecycle.run).not.toHaveBeenCalled();
});

it("replays recorded actions with a fresh execution and advisory comparison", async () => {
  lifecycle.run.mockResolvedValue({ captures: [], operations: [], status: "completed" });
  const state = await workspace.state();
  const first = await runProductCapture(state, {
    feature,
    task: "T001",
    journey: { url: "http://127.0.0.1:3000/", actions: [{ kind: "click", selector: "button" }] },
  });
  if (!first.ok) throw new Error(first.error.message);
  const second = await runProductCapture(state, {
    feature,
    task: "T001",
    replay: first.value.runId,
  });
  if (!second.ok) throw new Error(second.error.message);
  expect(lifecycle.run).toHaveBeenCalledTimes(2);
  expect(lifecycle.run.mock.calls[1]?.[0].journey).toEqual(
    lifecycle.run.mock.calls[0]?.[0].journey,
  );
  expect(second.value.runId).not.toBe(first.value.runId);
  expect(second.value.behaviorChange).toMatchObject({
    change: "compare-observations",
    sameSubject: true,
    before: { runId: first.value.runId },
  });
  const current = await store.readProductRecord(state, { feature });
  if (!current.ok) throw new Error(current.error.message);
  expect(current.value.state.captureRuns).toHaveLength(2);
  expect(current.value.state.reviews).toEqual([]);
});

it("surfaces optional matching replays through work after edits and removes them after a rerun", async () => {
  lifecycle.run.mockResolvedValue({ captures: [], operations: [], status: "completed" });
  const state = await workspace.state();
  const first = await runProductCapture(state, {
    feature,
    task: "T001",
    journey: { url: "http://127.0.0.1:3000/" },
  });
  if (!first.ok) throw new Error(first.error.message);
  await workspace.write("src/value.mjs", "export const value = 3;\n");
  const work = await runProductWork(state, { feature, task: "T001" });
  if (!work.ok) throw new Error(work.error.message);
  expect(work.value).toMatchObject({
    mayEdit: true,
    journeyFeedback: {
      replay: {
        advisory: true,
        runs: [
          {
            runId: first.value.runId,
            command: expect.stringContaining(`--replay=${first.value.runId}`),
          },
        ],
      },
    },
  });
  const rerun = await runProductCapture(state, {
    feature,
    task: "T001",
    replay: first.value.runId,
  });
  if (!rerun.ok) throw new Error(rerun.error.message);
  const refreshed = await runProductWork(state, { feature, task: "T001" });
  if (!refreshed.ok) throw new Error(refreshed.error.message);
  expect(refreshed.value.journeyFeedback?.replay).toBeUndefined();
});
