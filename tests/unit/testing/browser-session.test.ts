import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBrowserSession } from "../../../src/testing/browser-session.js";
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
