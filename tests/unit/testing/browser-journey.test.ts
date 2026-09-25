import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserSecurityError } from "../../../src/testing/browser-files.js";
import {
  type BrowserJourney,
  browserJourneySchema,
  runBrowserJourney,
} from "../../../src/testing/browser-journey.js";
import type { BrowserOperation } from "../../../src/testing/browser-session.js";
import {
  BrowserRuntimeError,
  BrowserUnavailableError,
} from "../../../src/testing/chrome-transport.js";
import { browserDom } from "../support/browser-dom.js";

const browser = vi.hoisted(() => ({
  open: vi.fn(),
  capture: vi.fn(),
  sample: vi.fn(),
  close: vi.fn(),
  navigate: vi.fn(),
  resize: vi.fn(),
  operations: [] as BrowserOperation[],
}));
vi.mock("../../../src/testing/browser-session.js", () => ({ openBrowserSession: browser.open }));
beforeEach(() => {
  vi.clearAllMocks();
  browser.operations = [];
  browser.navigate.mockResolvedValue(undefined);
  browser.resize.mockResolvedValue(undefined);
  browser.close.mockResolvedValue(undefined);
  browser.capture.mockResolvedValue({ id: "CAP-first", path: "/tmp/frame.png" });
  browser.sample.mockResolvedValue({
    count: 1,
    visible: true,
    inViewport: true,
    enabled: true,
    text: "Miss",
    attribute: null,
    truncated: false,
  });
  browser.open.mockResolvedValue({
    navigate: browser.navigate,
    resize: browser.resize,
    capture: browser.capture,
    sample: browser.sample,
    close: browser.close,
    get operations() {
      return browser.operations;
    },
    record: (kind: BrowserOperation["kind"], description: string, result: unknown) => {
      browser.operations.push({
        id: "OP-terminal",
        kind,
        description,
        completedAt: "2026-09-08T00:00:00Z",
        measurement: { json: JSON.stringify(result), truncated: false },
      });
      return "OP-terminal";
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const options = {
  directory: "/tmp/visp-journey-test",
  subjectDigest: "a".repeat(64),
  journey: {
    url: "http://localhost/",
    actions: [
      { kind: "wait-for" as const, selector: "#result", text: "Hit", timeoutMs: 1, capture: false },
    ],
  },
};

it("resizes the existing session before capturing without navigating again", async () => {
  const result = await runBrowserJourney({
    ...options,
    journey: browserJourneySchema.parse({
      url: "http://localhost/",
      viewport: { width: 390, height: 844 },
      actions: [{ kind: "resize", viewport: { width: 844, height: 390 }, capture: true }],
    }),
  });
  expect(result.status).toBe("completed");
  expect(browser.navigate).toHaveBeenCalledOnce();
  expect(browser.resize).toHaveBeenCalledExactlyOnceWith({ width: 844, height: 390 });
  expect(browser.capture).toHaveBeenCalledTimes(2);
  expect(browser.capture.mock.invocationCallOrder[1]).toBeGreaterThan(
    browser.resize.mock.invocationCallOrder[0] ?? 0,
  );
});

it.each([0, -1, 1.5, 16385])("rejects invalid resize width %s before startup", async (width) => {
  await expect(
    runBrowserJourney({
      ...options,
      journey: {
        url: "http://localhost/",
        actions: [{ kind: "resize", viewport: { width, height: 390 }, capture: false }],
      },
    }),
  ).rejects.toThrow();
  expect(browser.open).not.toHaveBeenCalled();
});

it("retains pre-resize evidence when viewport dispatch fails", async () => {
  browser.resize.mockRejectedValueOnce(new BrowserRuntimeError("Resize disconnected", "failed"));
  const result = await runBrowserJourney({
    ...options,
    journey: {
      url: "http://localhost/",
      actions: [{ kind: "resize", viewport: { width: 844, height: 390 }, capture: true }],
    },
  });
  expect(result).toMatchObject({
    status: "failed",
    failure: { kind: "environment", actionIndex: 0, message: "Resize disconnected" },
    captures: [{ id: "CAP-first" }],
  });
  expect(browser.close).toHaveBeenCalledOnce();
});

it("keeps terminal mismatch and existing captures when its diagnostic screenshot is unavailable", async () => {
  browser.capture
    .mockResolvedValueOnce({ id: "CAP-first", path: "/tmp/frame.png" })
    .mockRejectedValueOnce(new Error("Screenshot disconnected"));
  const result = await runBrowserJourney(options);
  expect(result).toMatchObject({
    status: "timed-out",
    failure: {
      operationId: "OP-terminal",
      diagnosticGaps: [expect.stringContaining("Screenshot disconnected")],
    },
  });
  expect(result.captures).toHaveLength(1);
  expect(result.operations).toHaveLength(1);
  expect(browser.close).toHaveBeenCalledOnce();
});

it("does not publish partial diagnostic evidence across a detected browser security failure", async () => {
  browser.capture
    .mockResolvedValueOnce({ id: "CAP-first" })
    .mockRejectedValueOnce(new BrowserSecurityError("Outside repository request"));
  await expect(runBrowserJourney(options)).rejects.toThrow("Outside repository");
  expect(browser.close).toHaveBeenCalledOnce();
});

it.each(["failed", "timed-out"] as const)(
  "retains observations across an established browser runtime failure (%s)",
  async (status) => {
    browser.sample.mockRejectedValueOnce(
      new BrowserRuntimeError("Browser stopped responding", status),
    );
    const result = await runBrowserJourney(options);
    expect(result).toMatchObject({
      status,
      failure: { kind: "environment", message: "Browser stopped responding", actionIndex: 0 },
      captures: [{ id: "CAP-first" }],
    });
    expect(browser.capture).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  },
);

it("keeps startup failures distinct from an executed partial journey", async () => {
  browser.open.mockRejectedValueOnce(new BrowserUnavailableError("Missing browser"));
  await expect(runBrowserJourney(options)).rejects.toThrow("Missing browser");
  expect(browser.capture).not.toHaveBeenCalled();
});

it("rejects impossible capture budgets before opening a browser", async () => {
  const journey = {
    url: "http://localhost/",
    actions: Array.from({ length: 6 }, () => ({ kind: "key", key: "Enter", capture: true })),
  };
  expect(browserJourneySchema.safeParse(journey).success).toBe(false);
  await expect(
    runBrowserJourney({ ...options, journey: journey as BrowserJourney }),
  ).rejects.toThrow("six representative captures");
  expect(browser.open).not.toHaveBeenCalled();
});

it("bounds elapsed waits and aborts them without inventing an observed result", async () => {
  expect(
    browserJourneySchema.safeParse({
      url: "http://localhost/",
      actions: [{ kind: "wait", durationMs: 10001 }],
    }).success,
  ).toBe(false);
  const controller = new AbortController();
  const pending = runBrowserJourney({
    ...options,
    signal: controller.signal,
    journey: {
      url: options.journey.url,
      actions: [{ kind: "wait", durationMs: 10000, capture: false }],
    },
  });
  setTimeout(() => controller.abort(), 20);
  expect((await pending).status).toBe("cancelled");
});

it("distinguishes cancellation before startup without fabricating operations", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runBrowserJourney({ ...options, signal: controller.signal });
  expect(result).toMatchObject({ status: "cancelled", captures: [], operations: [] });
  expect(browser.open).not.toHaveBeenCalled();
});

it("bounds a stalled journey and never calls it completed", async () => {
  vi.useFakeTimers();
  browser.navigate.mockReturnValue(new Promise(() => {}));
  const pending = runBrowserJourney(options);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await pending).toMatchObject({
    status: "timed-out",
    captures: [],
    failure: { kind: "environment" },
  });
});

async function nativeSession() {
  const dom = browserDom();
  const session = await browser.open();
  const evaluate = async <R, A>(fn: (arg: A) => R, arg: A) => fn(arg);
  const click = vi.fn(async () => {}),
    move = vi.fn(async () => {}),
    tap = vi.fn(async () => {}),
    press = vi.fn(async () => {}),
    drag = vi.fn(async (_gesture: unknown, intermediate?: () => Promise<void>) => {
      await intermediate?.();
    });
  session.page = { evaluate, mouse: { click, move }, touchscreen: { tap }, keyboard: { press } };
  session.drag = drag;
  browser.sample.mockImplementation(evaluate);
  return { dom, click, move, tap, press, drag };
}

it("dispatches fixed native actions and terminal state checks without agent receipt construction", async () => {
  const native = await nativeSession();
  const result = await runBrowserJourney({
    ...options,
    journey: {
      url: options.journey.url,
      actions: [
        { kind: "key", key: "Enter", capture: true },
        { kind: "click", selector: "#range", position: { x: 0.2, y: 0.25 }, capture: false },
        { kind: "tap", selector: "#range", capture: false },
        { kind: "move", selector: "#range", position: { x: 0.5, y: 0.6 }, capture: false },
        { kind: "scroll", selector: "#range", capture: false },
        { kind: "wait-for", selector: "#range", text: "Ready", capture: false },
      ],
    },
  });
  expect(result.status).toBe("completed");
  expect(native.press).toHaveBeenCalledWith("Enter");
  expect(native.click).toHaveBeenCalledWith(160, 140);
  expect(native.tap).toHaveBeenCalledWith(280, 200);
  expect(native.move).toHaveBeenCalledTimes(2);
  expect(result.captures).toHaveLength(3);
});

it.each([false, true])(
  "executes bounded drag coordinates and optional held-state captures (%s)",
  async (explicit) => {
    const native = await nativeSession();
    const action = {
      kind: "drag" as const,
      selector: "#range",
      to: { x: 500, y: 300 },
      capture: explicit,
      ...(explicit
        ? {
            from: { x: 100, y: 100 },
            input: "touch" as const,
            steps: 4,
            durationMs: 0,
            captureDuring: true,
          }
        : {}),
    };
    const result = await runBrowserJourney({
      ...options,
      journey: { url: options.journey.url, actions: [action] },
    });
    expect(result.status).toBe("completed");
    expect(native.drag).toHaveBeenCalledWith(
      expect.objectContaining({
        from: explicit ? { x: 100, y: 100 } : { x: 280, y: 200 },
        input: explicit ? "touch" : "pointer",
        steps: explicit ? 4 : 12,
      }),
      explicit ? expect.any(Function) : undefined,
    );
    expect(result.captures).toHaveLength(explicit ? 3 : 2);
  },
);

it("retains coordinate/reachability failures without dispatching the rejected input", async () => {
  const native = await nativeSession();
  for (const from of [
    { x: 0, y: 0 },
    { x: 500, y: 500 },
  ]) {
    const result = await runBrowserJourney({
      ...options,
      journey: {
        url: options.journey.url,
        actions: [
          { kind: "drag", selector: "#range", from, to: { x: 1400, y: 500 }, capture: false },
        ],
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      failure: { message: expect.stringContaining("Drag must start") },
    });
  }
  native.dom.element.disabled = true;
  expect(
    await runBrowserJourney({
      ...options,
      journey: {
        url: options.journey.url,
        actions: [{ kind: "drag", selector: "#range", to: { x: 500, y: 300 }, capture: false }],
      },
    }),
  ).toMatchObject({ status: "failed", failure: { message: expect.stringContaining("disabled") } });
  expect(native.drag).not.toHaveBeenCalled();
});

it("checks explicit drag origins while retaining disabled and actual point protections", async () => {
  const native = await nativeSession();
  native.dom.document.elementFromPoint.mockImplementation((x?: number) =>
    x === 280 ? {} : native.dom.element,
  );
  const run = (from?: { x: number; y: number }) =>
    runBrowserJourney({
      ...options,
      journey: {
        url: options.journey.url,
        actions: [
          { kind: "drag", selector: "#range", from, to: { x: 400, y: 250 }, capture: false },
        ],
      },
    });
  expect((await run({ x: 100, y: 100 })).status).toBe("completed");
  expect((await run()).status).toBe("failed");
  expect((await run({ x: 280, y: 200 })).status).toBe("failed");
  native.dom.element.disabled = true;
  expect((await run({ x: 100, y: 100 })).status).toBe("failed");
  expect(native.drag).toHaveBeenCalledOnce();
});

it("keeps navigation and project-file failures explicit, with no invented successful journey", async () => {
  browser.navigate.mockRejectedValueOnce(new Error("Navigation disconnected"));
  await expect(runBrowserJourney(options)).rejects.toThrow("Navigation disconnected");
  await expect(
    runBrowserJourney({ ...options, journey: { url: "file:///missing/index.html", actions: [] } }),
  ).rejects.toThrow("explicit project root");
  const root = await mkdtemp(join(tmpdir(), "visp-journey-local-test-"));
  try {
    await writeFile(join(root, "index.html"), "<p>Ready</p>");
    const result = await runBrowserJourney({
      ...options,
      projectRoot: root,
      journey: { url: pathToFileURL(join(root, "index.html")).href, actions: [] },
    });
    expect(result).toMatchObject({ status: "completed", captures: [{ id: "CAP-first" }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("stops an active observation when cancellation arrives", async () => {
  const controller = new AbortController();
  browser.sample.mockImplementationOnce(async () => {
    controller.abort();
    return { count: 0 };
  });
  const result = await runBrowserJourney({ ...options, signal: controller.signal });
  expect(result.status).toBe("cancelled");
});
