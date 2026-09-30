import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserBehaviorFailure } from "../../../src/testing/browser-observations.js";
import { interactionPage, openBrowserSession } from "../../../src/testing/browser-session.js";
import { pngHeader } from "../support/workspace.js";

const transport = vi.hoisted(() => ({
  send: vi.fn(),
  close: vi.fn(),
  onEvent: vi.fn(() => () => {}),
}));
vi.mock("../../../src/testing/chrome-transport.js", () => ({
  launchChrome: vi.fn(async () => transport),
}));
let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  transport.onEvent.mockImplementation(() => () => {});
  root = await mkdtemp(join(tmpdir(), "visp-session-test-"));
  transport.send.mockImplementation(async (method: string) => {
    if (method === "Target.createTarget") return { targetId: "target" };
    if (method === "Target.attachToTarget") return { sessionId: "session" };
    if (method === "Runtime.evaluate")
      return { result: { value: "http://localhost:1234/User/Alice" } };
    if (method === "Page.captureScreenshot")
      return { data: pngHeader(1280, 720).toString("base64") };
    return {};
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("browser session ownership", () => {
  it("maps invalid CSS selectors to a behavior failure", async () => {
    const send = Object.assign(
      vi.fn(async () => ({
        exceptionDetails: {
          text: "Uncaught",
          exception: {
            className: "DOMException",
            description:
              "SyntaxError: Failed to execute 'querySelectorAll' on 'Document': 'button:contains(Start)' is not a valid selector.",
          },
        },
      })),
      { sessionId: "session", targetId: "target" },
    );
    const page = interactionPage(send, () => {});
    await expect(
      page.evaluate(
        (selector) => document.querySelectorAll(selector).length,
        "button:contains(Start)",
      ),
    ).rejects.toThrow(BrowserBehaviorFailure);
  });
  it("records viewport changes and preserves earlier capture dimensions", async () => {
    const initial = { width: 390, height: 844 };
    const session = await openBrowserSession({
      directory: root,
      subjectDigest: "a".repeat(64),
      viewport: initial,
    });
    initial.width = 500;
    const before = await session.capture();
    const viewport = { width: 844, height: 390 };
    await session.resize(viewport);
    viewport.width = 700;
    const after = await session.capture();
    expect(before.viewport).toEqual({ width: 390, height: 844 });
    expect(after.viewport).toEqual({ width: 844, height: 390 });
    expect(after.steps).toContain("Resize viewport from 390×844 to 844×390");
    expect(transport.send).toHaveBeenCalledWith(
      "Emulation.setDeviceMetricsOverride",
      { width: 844, height: 390, deviceScaleFactor: 1, mobile: false },
      "session",
    );
    expect(transport.send.mock.calls.filter(([method]) => method === "Page.navigate")).toEqual([]);
    await session.close();
  });

  it("does not change recorded viewport or claim success after rejected resize", async () => {
    const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
    await expect(session.resize({ width: 0, height: 390 })).rejects.toThrow("Viewport dimensions");
    transport.send.mockRejectedValueOnce(new Error("browser disconnected"));
    await expect(session.resize({ width: 844, height: 390 })).rejects.toThrow("disconnected");
    expect(session.operations).toEqual([]);
    expect((await session.capture()).viewport).toEqual({ width: 1280, height: 720 });
    await session.close();
    await expect(session.resize({ width: 844, height: 390 })).rejects.toThrow("closed");
  });

  it("does not publish a viewport change completing after cancellation", async () => {
    const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
    let release: ((value: Record<string, unknown>) => void) | undefined;
    transport.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = session.resize({ width: 844, height: 390 });
    await vi.waitFor(() => expect(release).toBeDefined());
    await session.close();
    release?.({});
    await expect(pending).rejects.toThrow("closed");
    expect(session.operations).toEqual([]);
  });

  it("owns capture IDs and actual bytes and counts completed input operations", async () => {
    const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
    await session.navigate("http://localhost:1234/User/Alice");
    await session.page.mouse.click(30, 40);
    const capture = await session.capture();
    expect(capture.provenance).toBe("runner-captured");
    expect(capture.id).toMatch(/^CAP-/);
    expect(await readFile(capture.path)).toEqual(pngHeader(1280, 720));
    expect(capture.steps).toEqual([
      "Navigate http://localhost:1234/User/Alice",
      "Move pointer to 30,40",
      "Click 30,40",
    ]);
    expect(capture.operationIndex).toBe(session.operations.length - 1);
    expect(session.operations.filter((entry) => entry.kind === "pointer")).toHaveLength(2);
    expect(session.operations.find((entry) => entry.kind === "capture")?.captureId).toBe(
      capture.id,
    );
    expect(session.operations.find((entry) => entry.kind === "measure")?.measurement).toEqual({
      json: JSON.stringify("http://localhost:1234/User/Alice"),
      truncated: false,
    });
    const copied = session.operations as unknown[];
    copied.length = 0;
    expect(session.operations.length).toBeGreaterThan(0);
    await session.close();
    expect(transport.close).toHaveBeenCalledOnce();
  });
  it.each([
    [200, "http://localhost:1234/a", "Navigate http://localhost:1234/a (HTTP 200)"],
    [
      200,
      "http://localhost:1234/b",
      "Navigate http://localhost:1234/a (HTTP 200, redirected to http://localhost:1234/b)",
    ],
    [404, "http://localhost:1234/a", "Navigate http://localhost:1234/a (HTTP 404)"],
  ])("records the main document answer %s from %s", async (status, finalUrl, description) => {
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    transport.onEvent.mockImplementation(((listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as never);
    const emit = (params: Record<string, unknown>, sessionId = "session") => {
      for (const listener of listeners)
        listener({ method: "Network.responseReceived", sessionId, params });
    };
    const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
    transport.send.mockImplementation(async (method: string) => {
      if (method === "Page.navigate") {
        // Subresources, other loaders and other sessions never describe this navigation.
        emit({ type: "Script", loaderId: "L1", response: { status: 500, url: "x" } });
        emit({ type: "Document", loaderId: "L0", response: { status: 500, url: "x" } });
        emit({ type: "Document", loaderId: "L1", response: { status, url: finalUrl } }, "other");
        emit({ type: "Document", loaderId: "L1", response: { status, url: finalUrl } });
        return { loaderId: "L1" };
      }
      return {};
    });
    const navigation = session.navigate("http://localhost:1234/a");
    if (status >= 400) {
      await expect(navigation).rejects.toThrow(`answered HTTP ${status}`);
      await expect(navigation).rejects.toBeInstanceOf(BrowserBehaviorFailure);
    } else await navigation;
    expect(session.operations.map((entry) => entry.description)).toEqual([description]);
    await session.close();
  });
  describe("URLs VISP serves itself", () => {
    const origin = "http://127.0.0.1:5555";
    const present = (url: string) =>
      url.startsWith(`${origin}/`) ? `project:${url.slice(origin.length)}` : url;
    const navigateAnswering = async (
      status: number,
      finalUrl: string,
      annotate?: (url: string) => string | undefined,
    ) => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      transport.onEvent.mockImplementation(((
        listener: (event: Record<string, unknown>) => void,
      ) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }) as never);
      const session = await openBrowserSession({
        directory: root,
        subjectDigest: "a".repeat(64),
        present,
      });
      transport.send.mockImplementation(async (method: string) => {
        if (method === "Page.navigate") {
          for (const listener of listeners)
            listener({
              method: "Network.responseReceived",
              sessionId: "session",
              params: { type: "Document", loaderId: "L1", response: { status, url: finalUrl } },
            });
          return { loaderId: "L1" };
        }
        return {};
      });
      const navigation = session.navigate(`${origin}/index.html#go`, { annotate });
      return { session, navigation };
    };

    it("names the project URL and adds the served digest", async () => {
      const { session, navigation } = await navigateAnswering(200, `${origin}/index.html`, (url) =>
        url === `${origin}/index.html` ? "served by VISP from the project, sha256 abc" : undefined,
      );
      await navigation;
      expect(session.operations.map((entry) => entry.description)).toEqual([
        "Navigate project:/index.html#go (HTTP 200), served by VISP from the project, sha256 abc",
      ]);
      await session.close();
    });

    it("shows a redirect target as a project URL, without the port", async () => {
      const { session, navigation } = await navigateAnswering(200, `${origin}/sub/`);
      await navigation;
      expect(session.operations[0]?.description).toBe(
        "Navigate project:/index.html#go (HTTP 200, redirected to project:/sub/)",
      );
      await session.close();
    });

    it("names a capture by its project URL, never the ephemeral port, but navigates the real one", async () => {
      const { session, navigation } = await navigateAnswering(200, `${origin}/index.html`);
      await navigation;
      transport.send.mockImplementation(async (method: string) => {
        if (method === "Runtime.evaluate") return { result: { value: `${origin}/index.html#go` } };
        if (method === "Page.captureScreenshot")
          return { data: pngHeader(1280, 720).toString("base64") };
        return {};
      });
      const capture = await session.capture();
      expect(capture.route).toBe("project:/index.html#go");
      expect(capture.steps).toEqual(["Navigate project:/index.html#go (HTTP 200)"]);
      expect(session.operations.find((entry) => entry.kind === "capture")?.description).toBe(
        "Capture project:/index.html#go",
      );
      await session.close();
    });

    it("explains a missing project file and does not annotate a failed answer", async () => {
      const annotate = vi.fn(() => "sha");
      const { session, navigation } = await navigateAnswering(
        404,
        `${origin}/index.html`,
        annotate,
      );
      await expect(navigation).rejects.toThrow(
        "project:/index.html#go does not exist in the project (HTTP 404); check the path relative to the project root.",
      );
      await expect(navigation).rejects.toBeInstanceOf(BrowserBehaviorFailure);
      expect(annotate).not.toHaveBeenCalled();
      expect(session.operations[0]?.description).toBe("Navigate project:/index.html#go (HTTP 404)");
      await session.close();
    });

    it("explains a refused project path and points built apps to their own server", async () => {
      const { session, navigation } = await navigateAnswering(403, `${origin}/index.html`);
      await expect(navigation).rejects.toThrow(
        /could not be served from the project \(HTTP 403\).*dist\/.*own server/,
      );
      await session.close();
    });
  });
  it("points an HTTP 4xx from another server to the project: URL", async () => {
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    transport.onEvent.mockImplementation(((listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as never);
    const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
    transport.send.mockImplementation(async (method: string) => {
      if (method === "Page.navigate") {
        for (const listener of listeners)
          listener({
            method: "Network.responseReceived",
            sessionId: "session",
            params: {
              type: "Document",
              loaderId: "L1",
              response: { status: 404, url: "http://localhost:1234/a" },
            },
          });
        return { loaderId: "L1" };
      }
      return {};
    });
    await expect(session.navigate("http://localhost:1234/a")).rejects.toThrow(
      'for a static page use "project:/<file>" as the journey url',
    );
    await session.close();
  });
  it("ignores an application exception event arriving after close began", async () => {
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    transport.onEvent.mockImplementation(((listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as never);
    const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
    const exception = {
      method: "Runtime.exceptionThrown",
      sessionId: "session",
      params: { exceptionDetails: { text: "Uncaught" } },
    };
    const closing = session.close();
    expect(() => {
      for (const listener of listeners) listener(exception);
    }).not.toThrow();
    await closing;
    expect(session.operations).toEqual([]);
    expect(() => session.assertHealthy?.()).not.toThrow();
  });
  it("does not record a successful click when browser input fails", async () => {
    const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
    transport.send.mockRejectedValueOnce(new Error("browser disconnected"));
    await expect(session.page.mouse.click(30, 40)).rejects.toThrow("disconnected");
    expect(session.operations).toEqual([]);
    await session.close();
  });
  it("rejects ambient file navigation and closes a partially initialized browser", async () => {
    const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
    await expect(session.navigate("file:///etc/passwd")).rejects.toThrow("HTTP(S)");
    await session.close();
    transport.send.mockRejectedValueOnce(new Error("cannot attach"));
    await expect(
      openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) }),
    ).rejects.toThrow("cannot attach");
    expect(transport.close).toHaveBeenCalledTimes(2);
  });
  it("preserves actual observed measurement values with a bounded total delivery budget", async () => {
    const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
    transport.send.mockResolvedValue({
      result: { value: { reachable: true, rect: { x: 10, y: 20, width: 100, height: 44 } } },
    });
    await session.page.evaluate(() => null, undefined);
    expect(JSON.parse(session.operations[0]?.measurement?.json ?? "null")).toEqual({
      reachable: true,
      rect: { x: 10, y: 20, width: 100, height: 44 },
    });
    transport.send.mockResolvedValue({ result: { value: "x".repeat(10_000) } });
    for (let index = 0; index < 10; index++) await session.page.evaluate(() => null, undefined);
    const measurements = session.operations.flatMap((entry) =>
      entry.measurement ? [entry.measurement] : [],
    );
    expect(measurements.reduce((total, item) => total + item.json.length, 0)).toBeLessThanOrEqual(
      24_000,
    );
    expect(measurements.slice(1).every((item) => item.truncated && item.json.length <= 4_000)).toBe(
      true,
    );
    const terminal = {
      expected: { enabled: false },
      actual: { enabled: true },
      matched: false,
      polls: 500,
    };
    const id = session.record("observe", "Observe exhausted launch", terminal);
    expect(session.operations.at(-1)).toMatchObject({
      id,
      kind: "observe",
      measurement: { json: JSON.stringify(terminal), truncated: false },
    });
    await session.close();
  });
});

it("does not publish a screenshot arriving after session cleanup", async () => {
  const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
  let release: ((value: Record<string, unknown>) => void) | undefined;
  transport.send.mockImplementation(async (method: string) => {
    if (method === "Runtime.evaluate") return { result: { value: "http://localhost/" } };
    if (method === "Page.captureScreenshot")
      return new Promise<Record<string, unknown>>((resolve) => {
        release = resolve;
      });
    return {};
  });
  const pending = session.capture();
  await vi.waitFor(() => expect(release).toBeDefined());
  await session.close();
  release?.({ data: pngHeader(1280, 720).toString("base64") });
  await expect(pending).rejects.toThrow(/closed/);
  expect(await readdir(root)).toEqual([]);
});

it("makes every concurrent closer await the same process cleanup", async () => {
  const session = await openBrowserSession({ directory: root, subjectDigest: "a".repeat(64) });
  let release = () => {};
  transport.close.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = session.close(),
    second = session.close();
  let completed = false;
  void second.then(() => {
    completed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(completed).toBe(false);
  release();
  await Promise.all([first, second]);
  expect(transport.close).toHaveBeenCalledOnce();
});
