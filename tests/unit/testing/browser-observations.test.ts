import { afterEach, expect, it, vi } from "vitest";
import { browserJourneySchema } from "../../../src/testing/browser-journey.js";
import {
  matchesObservation,
  observeElement,
  scrollToElement,
  waitForObservation,
} from "../../../src/testing/browser-observations.js";
import { actAtPoint, resolveElementPoint } from "../../../src/testing/browser-points.js";
import type { BrowserSession } from "../../../src/testing/browser-session.js";
import { browserDom } from "../support/browser-dom.js";

afterEach(() => vi.unstubAllGlobals());

const actual = {
  count: 1,
  visible: true,
  inViewport: false,
  enabled: false,
  text: "Empty",
  attribute: null,
  truncated: false,
  textTruncated: false,
  attributeTruncated: false,
};
it("separates presence, rendered visibility and enabled state from viewport reachability", () => {
  expect(matchesObservation({ selector: "button", enabled: false, text: "Empty" }, actual)).toBe(
    true,
  );
  expect(matchesObservation({ selector: "button", visibility: "hidden" }, actual)).toBe(false);
  expect(
    matchesObservation({ selector: "button", visibility: "hidden" }, { ...actual, visible: false }),
  ).toBe(true);
  expect(
    matchesObservation({ selector: "button", visibility: "absent" }, { ...actual, count: 0 }),
  ).toBe(true);
  expect(matchesObservation({ selector: "button", enabled: false }, { ...actual, count: 0 })).toBe(
    false,
  );
  expect(
    matchesObservation(
      { selector: "button", text: "Empty" },
      { ...actual, truncated: true, textTruncated: true },
    ),
  ).toBe(false);
  expect(
    matchesObservation(
      { selector: "button", attribute: { name: "data-phase", value: null } },
      actual,
    ),
  ).toBe(true);
  expect(
    matchesObservation(
      { selector: "button", attribute: { name: "data-phase", value: null } },
      { ...actual, truncated: true, textTruncated: true },
    ),
  ).toBe(true);
});

it("rejects contradictory absent-element conditions and oversized assertion payloads", () => {
  for (const condition of [
    { text: "" },
    { enabled: false },
    { attribute: { name: "x", value: null } },
  ])
    expect(
      browserJourneySchema.safeParse({
        url: "https://example.test",
        actions: [{ kind: "wait-for", selector: "button", visibility: "absent", ...condition }],
      }).success,
    ).toBe(false);
  expect(
    browserJourneySchema.safeParse({
      url: "https://example.test",
      actions: [{ kind: "wait-for", selector: "button", text: "x".repeat(2049) }],
    }).success,
  ).toBe(false);
});

it("retains one terminal failure with actual values instead of a growing polling log", async () => {
  const sample = vi.fn(async () => actual),
    record = vi.fn(() => "operation-terminal");
  const session = { sample, record } as unknown as BrowserSession;
  await expect(
    waitForObservation(
      session,
      { selector: "button", enabled: true, timeoutMs: 60 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: "timed-out", operationId: "operation-terminal" });
  expect(sample.mock.calls.length).toBeGreaterThan(1);
  expect(record).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalledWith(
    "observe",
    "Observe button",
    expect.objectContaining({ actual, matched: false, polls: sample.mock.calls.length }),
  );
});

it("explains an exact-text mismatch without turning a substring into a passing observation", async () => {
  const observed = { ...actual, text: "Saved successfully" };
  const record = vi.fn(() => "text-mismatch");
  const session = { sample: async () => observed, record } as unknown as BrowserSession;
  await expect(
    waitForObservation(
      session,
      { selector: "#status", text: "Saved", timeoutMs: 1 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    status: "timed-out",
    operationId: "text-mismatch",
    message: expect.stringContaining(
      'Text matches exactly: expected "Saved", observed "Saved successfully"',
    ),
  });
  expect(record).toHaveBeenCalledOnce();
  expect(matchesObservation({ selector: "#status", text: "Saved successfully" }, observed)).toBe(
    true,
  );
});

it("observes actual DOM presence, independent visibility, disabled state and bounded values", () => {
  const dom = browserDom();
  expect(observeElement({ selector: "#range" })).toMatchObject({
    count: 1,
    visible: true,
    enabled: true,
    inViewport: true,
    text: "Ready",
    attribute: null,
  });
  expect(observeElement({ selector: "#missing" })).toMatchObject({
    count: 0,
    visible: false,
    enabled: null,
    text: null,
  });
  expect(observeElement({ selector: "#ambiguous" })).toMatchObject({ count: 2, visible: false });
  dom.element.disabled = true;
  expect(observeElement({ selector: "#range" }).enabled).toBe(false);
  dom.element.disabled = false;
  dom.element.inert = true;
  expect(observeElement({ selector: "#range" }).enabled).toBe(false);
  dom.rect.y = 900;
  expect(observeElement({ selector: "#range" })).toMatchObject({
    visible: true,
    inViewport: false,
  });
  dom.rect.y = -300;
  expect(observeElement({ selector: "#range" }).inViewport).toBe(false);
  dom.rect.y = 80;
  dom.rect.x = -500;
  expect(observeElement({ selector: "#range" }).inViewport).toBe(false);
  dom.rect.x = 1400;
  expect(observeElement({ selector: "#range" }).inViewport).toBe(false);
  dom.element.textContent = "x".repeat(3000);
  dom.attributes.phase = "y".repeat(3000);
  const long = observeElement({ selector: "#range", attribute: { name: "phase", value: "ready" } });
  expect(long).toMatchObject({ truncated: true, textTruncated: true, attributeTruncated: true });
  expect(long.text).toHaveLength(2048);
  expect(long.attribute).toHaveLength(2048);
  dom.element.textContent = null;
  expect(
    observeElement({ selector: "#range", attribute: { name: "missing", value: null } }).attribute,
  ).toBeNull();
});

it("identifies rendered hiding through area, styles and ancestors", () => {
  for (const hidden of ["area", "display", "visibility", "opacity", "ancestor"]) {
    const dom = browserDom();
    if (hidden === "area") dom.rect.width = 0;
    if (hidden === "display") dom.style.display = "none";
    if (hidden === "visibility") dom.style.visibility = "hidden";
    if (hidden === "opacity") dom.style.opacity = "0";
    if (hidden === "ancestor") dom.hideAncestor();
    expect(observeElement({ selector: "#range" }).visible).toBe(false);
  }
});

it("settles explicit scrolling and records the initial position without polling artifacts", async () => {
  const dom = browserDom();
  dom.rect.y = 1000;
  const record = vi.fn(() => "OP-scroll");
  const session = {
    sample: async <R, A>(fn: (arg: A) => R, arg: A) => fn(arg),
    record,
  } as unknown as BrowserSession;
  await scrollToElement(session, { selector: "#range" }, new AbortController().signal);
  expect(dom.element.scrollIntoView).toHaveBeenCalledWith({
    block: "center",
    inline: "nearest",
    behavior: "instant",
  });
  expect(record).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalledWith(
    "scroll",
    "Scroll #range into view",
    expect.objectContaining({
      before: expect.objectContaining({ y: 0, inViewport: false }),
      after: expect.objectContaining({ y: 400, inViewport: true }),
      matched: true,
    }),
  );
  await expect(
    scrollToElement(session, { selector: "#missing" }, new AbortController().signal),
  ).rejects.toThrow("found 0");
  dom.rect.y = 1000;
  dom.element.scrollIntoView.mockImplementation(() => {});
  await expect(
    scrollToElement(
      session,
      { selector: "#range", block: "start", timeoutMs: 1 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: "timed-out", operationId: "OP-scroll" });
});

it("records a successful terminal assertion and stops polling on cancellation", async () => {
  const sample = vi.fn(async () => actual),
    record = vi.fn(() => "OP-ready");
  const session = { sample, record } as unknown as BrowserSession;
  await waitForObservation(
    session,
    { selector: "button", enabled: false },
    new AbortController().signal,
  );
  expect(record).toHaveBeenCalledWith(
    "observe",
    "Observe button",
    expect.objectContaining({ matched: true, polls: 1 }),
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    waitForObservation(session, { selector: "button" }, controller.signal),
  ).rejects.toThrow();
  expect(sample).toHaveBeenCalledOnce();
});

it("resolves normalized CSS border-box coordinates and rejects unsupported geometry or hit targets", () => {
  const dom = browserDom();
  const target = { selector: "#range", position: { x: 0.2, y: 0.25 }, exact: true };
  expect(resolveElementPoint(target)).toMatchObject({
    x: 160,
    y: 140,
    error: undefined,
    borderBox: { x: 80, y: 80, width: 400, height: 240 },
  });
  for (const selector of ["#missing", "#ambiguous"])
    expect(resolveElementPoint({ ...target, selector }).error).toContain("Expected one control");
  for (const key of ["transform", "perspective", "rotate", "scale"] as const) {
    dom.style[key] = "unsupported";
    expect(resolveElementPoint(target).error).toContain("untransformed");
    expect(resolveElementPoint({ ...target, exact: false }).error).toBeUndefined();
    dom.style[key] = "none";
  }
  for (const position of [
    { x: -1, y: 0.5 },
    { x: 4, y: 0.5 },
    { x: 0.5, y: -1 },
    { x: 0.5, y: 5 },
  ])
    expect(resolveElementPoint({ ...target, position }).error).toContain("outside the viewport");
  dom.document.elementFromPoint.mockReturnValue(null);
  expect(resolveElementPoint(target).error).toContain("cannot receive");
  dom.document.elementFromPoint.mockReturnValue({});
  expect(resolveElementPoint(target).error).toContain("cannot receive");
});

it.each(["click", "tap", "move"] as const)(
  "rechecks actual native %s destinations and uses optional element-relative input",
  async (kind) => {
    const dom = browserDom();
    const move = vi.fn(async () => {}),
      click = vi.fn(async () => {}),
      tap = vi.fn(async () => {});
    const session = {
      page: {
        evaluate: async <R, A>(fn: (arg: A) => R, arg: A) => fn(arg),
        mouse: { move, click },
        touchscreen: { tap },
      },
    } as unknown as BrowserSession;
    await actAtPoint(session, { kind, selector: "#range", position: { x: 0.2, y: 0.25 } });
    if (kind === "tap") expect(tap).toHaveBeenCalledWith(160, 140);
    else expect(move).toHaveBeenCalledWith(160, 140, expect.any(Object));
    if (kind === "click") expect(click).toHaveBeenCalledWith(160, 140);
    dom.element.disabled = true;
    await expect(actAtPoint(session, { kind, selector: "#range" })).rejects.toThrow("disabled");
  },
);

it("accepts harmless hover motion but refuses covered targets", async () => {
  const dom = browserDom();
  const move = vi.fn(async () => {
      dom.rect.x += 10;
    }),
    click = vi.fn(async () => {});
  const session = {
    page: { evaluate: async <R, A>(fn: (arg: A) => R, arg: A) => fn(arg), mouse: { move, click } },
  } as unknown as BrowserSession;
  await actAtPoint(session, { kind: "click", selector: "#range" });
  expect(click).toHaveBeenCalled();
  click.mockClear();
  move.mockImplementation(async () => {
    dom.rect.y += 10;
  });
  await actAtPoint(session, { kind: "click", selector: "#range" });
  expect(click).toHaveBeenCalled();
  click.mockClear();
  move.mockImplementation(async () => {
    dom.document.elementFromPoint.mockReturnValue(null);
  });
  await expect(actAtPoint(session, { kind: "click", selector: "#range" })).rejects.toThrow(
    "cannot receive",
  );
  expect(click).not.toHaveBeenCalled();
  dom.document.elementFromPoint.mockReturnValue(dom.element);
  dom.style.transform = "rotate(30deg)";
  await expect(
    actAtPoint(session, { kind: "click", selector: "#range", position: { x: 0.2, y: 0.2 } }),
  ).rejects.toThrow("untransformed");
});

it("moves to a visible center without requiring the entire surface to fit onscreen", async () => {
  const dom = browserDom();
  dom.rect.height = 900;
  const move = vi.fn(async () => {});
  const session = {
    page: { evaluate: async <R, A>(fn: (arg: A) => R, arg: A) => fn(arg), mouse: { move } },
  } as unknown as BrowserSession;
  await actAtPoint(session, { kind: "move", selector: "#range" });
  expect(move).toHaveBeenCalledWith(280, 530, expect.any(Object));
  move.mockClear();
  dom.rect.y = 400;
  await expect(actAtPoint(session, { kind: "move", selector: "#range" })).rejects.toThrow(
    "clipped",
  );
  expect(move).not.toHaveBeenCalled();
});

it("validates the requested canvas point independently from its covered center or clipped far edge", async () => {
  const dom = browserDom();
  dom.document.elementFromPoint.mockImplementation(((x: number, y: number) =>
    x === 280 && y === 200 ? {} : dom.element) as () => unknown);
  const click = vi.fn(async () => {});
  const session = {
    page: {
      evaluate: async <R, A>(fn: (arg: A) => R, arg: A) => fn(arg),
      mouse: { move: vi.fn(async () => {}), click },
    },
  } as unknown as BrowserSession;
  await expect(
    actAtPoint(session, { kind: "click", selector: "#range", position: { x: 0.2, y: 0.25 } }),
  ).resolves.toBeUndefined();
  expect(click).toHaveBeenCalledWith(160, 140);
  await expect(actAtPoint(session, { kind: "click", selector: "#range" })).rejects.toThrow(
    "covered",
  );
  await expect(
    actAtPoint(session, { kind: "click", selector: "#range", position: { x: 0.5, y: 0.5 } }),
  ).rejects.toThrow("covered");
  dom.document.elementFromPoint.mockReturnValue(dom.element);
  dom.rect.width = 1600;
  await expect(
    actAtPoint(session, { kind: "click", selector: "#range", position: { x: 0.2, y: 0.25 } }),
  ).resolves.toBeUndefined();
  await expect(actAtPoint(session, { kind: "click", selector: "#range" })).rejects.toThrow(
    "clipped",
  );
  await expect(
    actAtPoint(session, { kind: "click", selector: "#range", position: { x: 0.9, y: 0.25 } }),
  ).rejects.toThrow("clipped");
  dom.element.disabled = true;
  await expect(
    actAtPoint(session, { kind: "click", selector: "#range", position: { x: 0.2, y: 0.25 } }),
  ).rejects.toThrow("disabled");
});
