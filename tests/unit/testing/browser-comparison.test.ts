import { afterEach, expect, it, vi } from "vitest";
import {
  browserComparisonSchema,
  compareBrowserValues,
  comparisonMatches,
  readComparison,
} from "../../../src/testing/browser-comparison.js";
import { browserJourneySchema } from "../../../src/testing/browser-journey.js";
import type { BrowserSession } from "../../../src/testing/browser-session.js";

afterEach(() => vi.unstubAllGlobals());
const action = browserComparisonSchema.parse({
  kind: "compare",
  left: { selector: "#hud" },
  right: { selector: "#result" },
  relation: "equal",
  mode: "number",
});
const value = (text: string | null) => ({ count: 1, value: text, truncated: false });

it("compares observed numbers and exact case-sensitive text without accepting missing, blank or truncated values", () => {
  expect(comparisonMatches(action, { left: value("001043"), right: value("001014") })).toBe(false);
  expect(comparisonMatches(action, { left: value("001014"), right: value("1014") })).toBe(true);
  for (const relation of ["less-than", "greater-than", "not-equal"] as const)
    expect(
      comparisonMatches(
        { ...action, relation },
        { left: value(relation === "less-than" ? "-1" : "1"), right: value("0") },
      ),
    ).toBe(true);
  expect(
    comparisonMatches(
      { ...action, mode: "text" },
      { left: value(" Route/A "), right: value("Route/A") },
    ),
  ).toBe(true);
  expect(
    comparisonMatches(
      { ...action, mode: "text" },
      { left: value("Route/a"), right: value("Route/A") },
    ),
  ).toBe(false);
  expect(
    comparisonMatches(
      { ...action, mode: "text", relation: "less-than" },
      { left: value("1"), right: value("2") },
    ),
  ).toBe(false);
  for (const left of [
    value(null),
    value(""),
    value(" "),
    value("NaN"),
    value("Infinity"),
    { ...value("1014"), count: 2 },
    { ...value("1014"), truncated: true },
  ])
    expect(comparisonMatches(action, { left, right: value("1014") })).toBe(false);
});

it("reads both real DOM targets in one sample and records a failing relation with its observed values", async () => {
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) =>
      selector === "#missing"
        ? []
        : [{ textContent: selector === "#hud" ? "1043" : "1014", getAttribute: () => "-1" }],
  });
  expect(readComparison(action)).toEqual({ left: value("1043"), right: value("1014") });
  expect(
    readComparison({
      ...action,
      left: { selector: "#hud", attribute: "data-velocity" },
      right: { value: "0" },
    }),
  ).toEqual({ left: value("-1"), right: value("0") });
  expect(readComparison({ ...action, left: { selector: "#missing" } }).left.value).toBeNull();
  const record = vi.fn<BrowserSession["record"]>(() => "recorded-comparison");
  const session = {
    sample: async (fn: typeof readComparison, arg: typeof action) => fn(arg),
    record,
  } as unknown as BrowserSession;
  await expect(compareBrowserValues(session, action)).rejects.toMatchObject({
    status: "failed",
    operationId: "recorded-comparison",
  });
  expect(record.mock.calls[0]?.[2]).toMatchObject({
    matched: false,
    expected: action,
    actual: { left: { value: "1043" }, right: { value: "1014" } },
  });
  await expect(
    compareBrowserValues(session, { ...action, right: { value: "1043" } }),
  ).resolves.toBeUndefined();
});

it("rejects unsupported comparison and cancellation requests before executing a journey", () => {
  const parse = (entry: unknown) =>
    browserJourneySchema.safeParse({ url: "http://localhost/", actions: [entry] }).success;
  expect(parse(action)).toBe(true);
  expect(parse({ ...action, relation: "less-than", mode: "text" })).toBe(false);
  expect(parse({ ...action, right: { selector: "#x", value: "fake" } })).toBe(false);
  const drag = { kind: "drag", selector: "canvas", to: { x: 10, y: 10 }, cancel: true };
  expect(parse(drag)).toBe(false);
  expect(parse({ ...drag, input: "touch" })).toBe(true);
});

it("explains missing attributes for every relation without weakening the comparison", async () => {
  const actual = { left: value(null), right: value("390") };
  const session = {
    sample: async () => actual,
    record: () => "missing-attribute",
  } as unknown as BrowserSession;
  for (const relation of ["equal", "not-equal", "less-than", "greater-than"] as const) {
    await expect(
      compareBrowserValues(session, {
        ...action,
        left: { selector: "body", attribute: "scrollWidth" },
        right: { value: "390" },
        relation,
      }),
    ).rejects.toMatchObject({
      status: "failed",
      operationId: "missing-attribute",
      message: expect.stringMatching(/left=.*null.*right=.*390.*getAttribute.*DOM properties/),
    });
  }
});

it("bounds comparison diagnostics while retaining full observations in the operation", async () => {
  const actual = { left: value("x".repeat(2048)), right: value("y".repeat(2048)) };
  const record = vi.fn<BrowserSession["record"]>(() => "long-comparison");
  const session = { sample: async () => actual, record } as unknown as BrowserSession;
  const error = await compareBrowserValues(session, action).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message.length).toBeLessThan(600);
  expect((error as Error).message).toContain('"truncated":true');
  expect(record.mock.calls[0]?.[2]).toMatchObject({ actual, matched: false });
});
