import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../../../src/core/hash.js";
import { BrowserSecurityError } from "../../../src/testing/browser-files.js";
import {
  type BrowserJourney,
  browserJourneySchema,
  runBrowserJourney,
} from "../../../src/testing/browser-journey.js";
import { BrowserBehaviorFailure } from "../../../src/testing/browser-observations.js";
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

it("retains captures and action index for invalid selector behavior", async () => {
  browser.sample.mockRejectedValueOnce(
    new BrowserBehaviorFailure("Invalid CSS selector: button:contains(Start)"),
  );
  const result = await runBrowserJourney(options);
  expect(result).toMatchObject({
    status: "failed",
    failure: {
      kind: "behavior",
      actionIndex: 0,
      message: expect.stringContaining("Invalid CSS selector"),
    },
  });
  expect(result.captures.length).toBeGreaterThan(0);
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

const dragJourney = (action: Record<string, unknown>) =>
  ({
    url: options.journey.url,
    actions: [{ kind: "drag", selector: "#range", capture: false, ...action }],
  }) as BrowserJourney;

it.each([
  // [rect, viewport width, position, by, expected from, expected to]
  [
    { x: 80, y: 80, width: 400, height: 240 },
    1280,
    { x: 0.25, y: 0.5 },
    { x: 0.5, y: 0.25 },
    [180, 200],
    [380, 260],
  ],
  [
    { x: 10, y: 20, width: 300, height: 180 },
    390,
    { x: 0.5, y: 0.25 },
    { x: -0.25, y: 0.5 },
    [160, 65],
    [85, 155],
  ],
  [
    { x: 80, y: 80, width: 400, height: 240 },
    1280,
    undefined,
    { x: 0, y: -0.5 },
    [280, 200],
    [280, 80],
  ],
] as const)(
  "resolves drag position and by as fractions of the element box (%#)",
  async (rect, width, position, by, expectedFrom, expectedTo) => {
    const native = await nativeSession();
    Object.assign(native.dom.rect, rect);
    vi.stubGlobal("innerWidth", width);
    const result = await runBrowserJourney({
      ...options,
      journey: dragJourney({ position, by }),
    });
    expect(result.status).toBe("completed");
    expect(native.drag).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { x: expectedFrom[0], y: expectedFrom[1] },
        to: { x: expectedTo[0], y: expectedTo[1] },
      }),
      undefined,
    );
  },
);

it("accepts a drag inside a scaled canvas box and rejects rotated geometry", async () => {
  const native = await nativeSession();
  native.dom.style.transform = "matrix(0.5, 0, 0, 0.5, 40, 12)";
  const scaled = await runBrowserJourney({
    ...options,
    journey: dragJourney({ position: { x: 0.5, y: 0.5 }, by: { x: 0.25, y: 0.5 } }),
  });
  expect(scaled.status).toBe("completed");
  expect(native.drag).toHaveBeenCalledWith(
    expect.objectContaining({ from: { x: 280, y: 200 }, to: { x: 380, y: 320 } }),
    undefined,
  );
  native.drag.mockClear();
  native.dom.style.transform = "matrix(0.866, 0.5, -0.5, 0.866, 0, 0)";
  expect(
    await runBrowserJourney({
      ...options,
      journey: dragJourney({ position: { x: 0.5, y: 0.5 }, by: { x: 0.25, y: 0.5 } }),
    }),
  ).toMatchObject({
    status: "failed",
    failure: { message: expect.stringContaining("rotated, skewed or perspective") },
  });
  expect(native.drag).not.toHaveBeenCalled();
});

it.each([
  ["rotated", "matrix(0.966, 0.259, -0.259, 0.966, 0, 0)"],
  ["skewed", "matrix(1, 0, 0.3, 1, 0, 0)"],
  ["flipped", "matrix(-1, 0, 0, 1, 0, 0)"],
  ["3D", "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)"],
])("refuses by alone and from with by on %s geometry", async (_name, transform) => {
  const native = await nativeSession();
  native.dom.style.transform = transform;
  for (const action of [
    { by: { x: 0.25, y: 0.25 } },
    { from: { x: 100, y: 100 }, by: { x: 0.25, y: 0.25 } },
  ]) {
    expect(await runBrowserJourney({ ...options, journey: dragJourney(action) })).toMatchObject({
      status: "failed",
      failure: { message: expect.stringContaining("rotated, skewed or perspective") },
    });
  }
  expect(native.drag).not.toHaveBeenCalled();
});

it("resolves by from an explicit start when the element centre is off screen", async () => {
  const native = await nativeSession();
  Object.assign(native.dom.rect, { x: 80, y: 80, width: 400, height: 2000 });
  const result = await runBrowserJourney({
    ...options,
    journey: dragJourney({ from: { x: 100, y: 100 }, by: { x: 0.25, y: 0.05 } }),
  });
  expect(result.status).toBe("completed");
  expect(native.drag).toHaveBeenCalledWith(
    expect.objectContaining({ from: { x: 100, y: 100 }, to: { x: 200, y: 200 } }),
    undefined,
  );
});

it("names the resolved coordinates when a fractional drag leaves the viewport", async () => {
  const native = await nativeSession();
  native.dom.rect.x = 1000;
  const result = await runBrowserJourney({
    ...options,
    journey: dragJourney({ position: { x: 0.5, y: 0.5 }, by: { x: 1, y: 0 } }),
  });
  expect(result).toMatchObject({
    status: "failed",
    failure: { message: expect.stringContaining("from 1200,200 to 1600,200") },
  });
  expect(native.drag).not.toHaveBeenCalled();
});

it("requires exactly one of to and by, and at most one of from and position", () => {
  const parse = (action: Record<string, unknown>) =>
    browserJourneySchema.safeParse(dragJourney(action));
  const to = { x: 5, y: 5 };
  const by = { x: 0.1, y: 0.1 };
  expect(parse({ to }).success).toBe(true);
  expect(parse({ by, position: { x: 0.5, y: 0.5 } }).success).toBe(true);
  expect(parse({ to, by })).toMatchObject({
    success: false,
    error: { issues: [{ message: expect.stringContaining("not both") }] },
  });
  expect(parse({}).success).toBe(false);
  expect(parse({ to, from: to, position: { x: 0.5, y: 0.5 } }).success).toBe(false);
  expect(parse({ by: { x: 1.5, y: 0 } }).success).toBe(false);
  expect(parse({ by, position: { x: 2, y: 0 } }).success).toBe(false);
});

it("captures held state, then each post-release offset in order, counted toward the cap", async () => {
  const native = await nativeSession();
  const log: string[] = [];
  let released = 0;
  native.drag.mockImplementation(async (_gesture: unknown, intermediate?: () => Promise<void>) => {
    log.push("drag");
    await intermediate?.();
    log.push("release");
    released = Date.now();
  });
  const times: number[] = [];
  browser.capture.mockImplementation(async () => {
    log.push("capture");
    times.push(Date.now() - released);
    return { id: `CAP-${log.length}`, path: "/tmp/frame.png" };
  });
  const result = await runBrowserJourney({
    ...options,
    journey: dragJourney({
      to: { x: 500, y: 300 },
      captureDuring: true,
      captureAfterMs: [100, 400],
    }),
  });
  expect(result.status).toBe("completed");
  // initial, held (before release), +100, +400, then the automatic final capture.
  expect(log).toEqual(["capture", "drag", "capture", "release", "capture", "capture", "capture"]);
  expect(result.captures).toHaveLength(5);
  expect(times[2]).toBeGreaterThanOrEqual(95);
  expect(times[3]).toBeGreaterThanOrEqual(395);
  expect(times[3]).toBeLessThan(1500);
});

it("counts post-release captures toward the six-capture cap and validates the offsets", () => {
  const journey = (action: Record<string, unknown>) =>
    browserJourneySchema.safeParse(dragJourney({ to: { x: 5, y: 5 }, ...action }));
  // 1 initial + held + 3 after + 1 final = 6
  expect(journey({ captureDuring: true, captureAfterMs: [50, 200, 2000] }).success).toBe(true);
  // capture: true replaces the automatic final capture, so it stays at six; a second captured action makes seven.
  expect(
    journey({ captureDuring: true, capture: true, captureAfterMs: [50, 200, 2000] }).success,
  ).toBe(true);
  const over = browserJourneySchema.safeParse({
    url: options.journey.url,
    actions: [
      {
        kind: "drag",
        selector: "#range",
        to: { x: 5, y: 5 },
        captureDuring: true,
        captureAfterMs: [50, 200, 2000],
        capture: true,
      },
      { kind: "wait", durationMs: 1, capture: true },
    ],
  });
  expect(over).toMatchObject({
    success: false,
    error: { issues: [{ message: "Journey exceeds six representative captures" }] },
  });
  for (const captureAfterMs of [[], [49], [2001], [100, 100], [400, 100], [1, 2, 3, 4], [100.5]])
    expect(journey({ captureAfterMs }).success).toBe(false);
});

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

describe("project: journeys (VISP-owned static server)", () => {
  let project: string;
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "visp-journey-project-"));
    await writeFile(join(project, "index.html"), "<p>Ready</p>");
    await writeFile(join(project, ".env"), "TOKEN=SECRET");
  });
  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });
  const projectOptions = (url = "project:/index.html", extra: object = {}) => ({
    ...options,
    projectRoot: project,
    journey: { url, actions: [] },
    ...extra,
  });
  const alive = (url: string) =>
    fetch(url).then(
      () => true,
      () => false,
    );
  /** Navigation mock that behaves like a browser: it really requests the loopback URL. */
  const requestingNavigation = (seen: { url?: string }) =>
    browser.navigate.mockImplementation(async (url: string) => {
      seen.url = url;
      await fetch(url);
    });

  it("accepts project URLs and refuses malformed or escaping ones", () => {
    for (const url of ["project:/index.html", "project:/a/b.html?x=1#y", "project:/"])
      expect(browserJourneySchema.safeParse({ url, actions: [] }).success).toBe(true);
    for (const url of [
      "project://host/index.html",
      "project:index.html",
      "project:/../x",
      "project:/%2e%2e/x",
      "project:/a%2fb",
      "project:/a\\b",
      "ftp://x/",
    ])
      expect(browserJourneySchema.safeParse({ url, actions: [] }).success).toBe(false);
  });

  it("requires an explicit project root and starts nothing without one", async () => {
    await expect(
      runBrowserJourney({ ...options, journey: { url: "project:/index.html", actions: [] } }),
    ).rejects.toThrow("explicit project root");
    expect(browser.open).not.toHaveBeenCalled();
  });

  it("navigates to a loopback URL, presents the project URL and records the served digest", async () => {
    const seen: { url?: string } = {};
    requestingNavigation(seen);
    const result = await runBrowserJourney(projectOptions("project:/index.html?level=2#go"));
    expect(result.status).toBe("completed");
    expect(seen.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html\?level=2#go$/);
    const [url, navigation] = browser.navigate.mock.calls[0] as [
      string,
      { annotate(url: string): string | undefined },
    ];
    // The session presents routes and operations through the server's mapper, port-free.
    const opened = browser.open.mock.calls[0]?.[0] as { present(url: string): string };
    expect(opened.present(url)).toBe("project:/index.html?level=2#go");
    expect(opened.present("https://example.com/x")).toBe("https://example.com/x");
    expect(navigation.annotate(url)).toBe(
      `served by VISP from the project, sha256 ${sha256("<p>Ready</p>").slice(0, 12)}`,
    );
  });

  it("does not use the server for http or file journeys", async () => {
    await runBrowserJourney(options);
    expect(browser.open.mock.calls[0]?.[0].present).toBeUndefined();
    expect(browser.navigate).toHaveBeenCalledExactlyOnceWith("http://localhost/");
  });

  it("closes the server after a completed journey", async () => {
    const seen: { url?: string } = {};
    requestingNavigation(seen);
    await runBrowserJourney(projectOptions());
    expect(await alive(seen.url ?? "")).toBe(false);
  });

  it("closes the server when the journey fails", async () => {
    const seen: { url?: string } = {};
    browser.navigate.mockImplementation(async (url: string) => {
      seen.url = url;
      throw new BrowserBehaviorFailure("HTTP 404");
    });
    expect((await runBrowserJourney(projectOptions())).status).toBe("failed");
    expect(await alive(seen.url ?? "")).toBe(false);
  });

  it("closes the server when navigation throws an unexpected error", async () => {
    const seen: { url?: string } = {};
    browser.navigate.mockImplementation(async (url: string) => {
      seen.url = url;
      throw new Error("Navigation disconnected");
    });
    await expect(runBrowserJourney(projectOptions())).rejects.toThrow("Navigation disconnected");
    expect(await alive(seen.url ?? "")).toBe(false);
  });

  it("closes the server when the browser cannot start", async () => {
    browser.open.mockImplementationOnce(async () => {
      throw new BrowserUnavailableError("no browser");
    });
    const spy = vi.spyOn(
      await import("../../../src/testing/project-server.js"),
      "startProjectServer",
    );
    await expect(runBrowserJourney(projectOptions())).rejects.toThrow("no browser");
    const server = await spy.mock.results[0]?.value;
    expect(await alive(`${server.origin}/index.html`)).toBe(false);
    spy.mockRestore();
  });

  it("closes the server when the run is aborted mid-journey", async () => {
    const controller = new AbortController();
    const seen: { url?: string } = {};
    browser.navigate.mockImplementation(async (url: string) => {
      seen.url = url;
      await fetch(url);
      expect(await alive(url)).toBe(true);
      controller.abort();
      throw new Error("aborted");
    });
    const result = await runBrowserJourney(
      projectOptions("project:/index.html", { signal: controller.signal }),
    );
    expect(result.status).toBe("cancelled");
    expect(await alive(seen.url ?? "")).toBe(false);
  });

  it("does not start a server when aborted before startup", async () => {
    const controller = new AbortController();
    controller.abort();
    const spy = vi.spyOn(
      await import("../../../src/testing/project-server.js"),
      "startProjectServer",
    );
    const result = await runBrowserJourney(
      projectOptions("project:/index.html", { signal: controller.signal }),
    );
    expect(result.status).toBe("cancelled");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("closes the server on a stalled journey timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const seen: { url?: string } = {};
    browser.navigate.mockImplementation((url: string) => {
      seen.url = url;
      return new Promise(() => {});
    });
    const pending = runBrowserJourney(projectOptions());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ status: "timed-out" });
    vi.useRealTimers();
    expect(await alive(seen.url ?? "")).toBe(false);
  });

  it("records what the project server refused as an observation", async () => {
    browser.navigate.mockImplementation(async (url: string) => {
      await fetch(url);
      await fetch(new URL("/.env", url));
    });
    const result = await runBrowserJourney(projectOptions());
    expect(result.status).toBe("completed");
    expect(browser.operations.at(-1)?.description).toContain("refused 1 request(s): 403 GET /.env");
    expect(browser.operations.at(-1)?.description).not.toContain("SECRET");
  });

  it("reports the true count of refused requests when only the first few are listed", async () => {
    browser.navigate.mockImplementation(async (url: string) => {
      await fetch(url);
      for (let i = 0; i < 8; i += 1) await fetch(new URL(`/.env${i}`, url)).catch(() => {});
      for (let i = 0; i < 8; i += 1) await fetch(new URL("/.git/config", url));
    });
    await runBrowserJourney(projectOptions());
    expect(browser.operations.at(-1)?.description).toMatch(
      /^VISP's project server refused 8 request\(s\), first 5: /,
    );
  });

  it("keeps the journey key independent of the port", async () => {
    const seen: string[] = [];
    browser.navigate.mockImplementation(async (url: string) => {
      seen.push(url);
    });
    await runBrowserJourney(projectOptions());
    await runBrowserJourney(projectOptions());
    expect(new Set(seen.map((url) => new URL(url).port)).size).toBe(2);
    const { productJourneyKey } = await import("../../../src/workflow/evidence/product-journey.js");
    const journey = browserJourneySchema.parse({ url: "project:/index.html", actions: [] });
    expect(productJourneyKey(journey)).toBe(productJourneyKey(browserJourneySchema.parse(journey)));
  });
});
