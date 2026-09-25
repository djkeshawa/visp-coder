import { describe, expect, it } from "vitest";
import {
  type BrowserJourney,
  browserJourneySchema,
} from "../../../../src/testing/browser-journey.js";
import {
  productJourneyGaps,
  productJourneyKey,
} from "../../../../src/workflow/evidence/product-journey.js";
import type { ProductReviewCapture } from "../../../../src/workflow/evidence/product-review.js";

const subject = "a".repeat(64);
const images: ProductReviewCapture[] = ["before", "after"].map((id) => ({
  id,
  path: `.visp/${id}.png`,
  sha256: "b".repeat(64),
  subjectDigest: subject,
  route: "http://localhost/",
  steps: ["Navigate"],
  viewport: { width: 10, height: 10 },
  createdAt: "2026-01-01T00:00:00Z",
  provenance: "runner-captured",
}));
const operation = (id: string, kind: string, captureId?: string) => ({
  id,
  kind,
  captureId,
  completedAt: "2026-01-01T00:00:00Z",
});
const run = {
  version: 1,
  provenance: "runner-executed",
  subjectDigest: subject,
  captures: images,
  operations: [
    operation("initial", "capture", "before"),
    operation("clicked", "pointer"),
    operation("final", "capture", "after"),
  ],
};
const options = {
  subjectDigest: subject,
  captureRuns: [run],
  images,
  linkedEvidence: ["before", "after"],
};
describe("required experience journey evidence", () => {
  it("retains viewport transitions in journey identity without counting resize as user input", () => {
    const journey = browserJourneySchema.parse({
      url: "https://example.test",
      actions: [{ kind: "resize", viewport: { width: 844, height: 390 } }],
    });
    expect(productJourneyKey(journey)).not.toBe(productJourneyKey({ ...journey, actions: [] }));
    expect(productJourneyKey(journey)).not.toBe(
      productJourneyKey(
        browserJourneySchema.parse({
          ...journey,
          actions: [{ kind: "resize", viewport: { width: 390, height: 844 } }],
        }),
      ),
    );
    expect(
      productJourneyGaps({
        ...options,
        captureRuns: [
          {
            ...run,
            operations: [
              operation("initial", "capture", "before"),
              operation("resized", "observe"),
              operation("final", "capture", "after"),
            ],
          },
        ],
      }),
    ).not.toEqual([]);
  });

  it("retains the old-completion observation window when identifying a reset replay", () => {
    const journey = browserJourneySchema.parse({
      url: "https://example.test",
      actions: [
        { kind: "click", selector: "#reset" },
        { kind: "wait", durationMs: 1000 },
        { kind: "wait-for", selector: "#status", text: "Ready" },
      ],
    });
    const shortened = {
      ...journey,
      actions: journey.actions.map((action) =>
        action.kind === "wait" ? { ...action, durationMs: 1 } : action,
      ),
    };
    expect(productJourneyKey(shortened)).not.toBe(productJourneyKey(journey));
  });
  it("permits capture/deadline retries while retaining gesture timing and expectations", () => {
    const journey = browserJourneySchema.parse({
      url: "https://example.test",
      actions: [
        {
          kind: "drag",
          selector: "canvas",
          from: { x: 10, y: 10 },
          to: { x: 100, y: 50 },
          input: "touch",
          captureDuring: true,
          steps: 12,
          durationMs: 200,
        },
        { kind: "click", selector: "canvas", position: { x: 0.2, y: 0.3 } },
        { kind: "wait-for", selector: "#result", text: "Hit", enabled: false, timeoutMs: 1000 },
      ],
    });
    const key = productJourneyKey(journey, "T001");
    expect(key).toMatch(/^journey-v3:/);
    const adjusted = {
      ...journey,
      actions: journey.actions.map((action) => ({
        ...action,
        capture: true,
        timeoutMs: 2000,
        captureDuring: false,
      })),
    } as BrowserJourney;
    expect(productJourneyKey(adjusted, "T001")).toBe(key);
    for (const changed of [
      { ...journey, url: "https://example.test/other" },
      { ...journey, viewport: { width: 390, height: 844 } },
      { ...journey, actions: [] },
      ...[
        { kind: "wait-for", selector: "#result", text: "Miss" },
        { kind: "wait-for", selector: "#other", text: "Hit" },
        {
          kind: "drag",
          selector: "canvas",
          from: { x: 10, y: 10 },
          to: { x: 100, y: 50 },
          input: "pointer",
        },
        { kind: "click", selector: "canvas", position: { x: 0.3, y: 0.3 } },
      ].map((action) => ({ ...journey, actions: [...journey.actions.slice(0, -1), action] })),
    ])
      expect(productJourneyKey(changed as BrowserJourney, "T001")).not.toBe(key);
    expect(productJourneyKey(journey, "T002")).not.toBe(key);
  });
  it("distinguishes a held pointer from an immediate press and changed movement steps", () => {
    const journey = browserJourneySchema.parse({
      url: "https://example.test",
      actions: [
        {
          kind: "drag",
          selector: "#launch",
          from: { x: 20, y: 20 },
          to: { x: 20, y: 20 },
          steps: 2,
          durationMs: 0,
        },
      ],
    });
    const key = productJourneyKey(journey);
    for (const change of [{ durationMs: 80 }, { steps: 3 }]) {
      expect(
        productJourneyKey({
          ...journey,
          actions: [{ ...journey.actions[0], ...change }],
        } as BrowserJourney),
      ).not.toBe(key);
    }
  });

  it.each([
    {
      kind: "drag",
      selector: "canvas",
      to: { x: 100, y: 100 },
      defaults: { input: "pointer", cancel: false, steps: 12, durationMs: 300 },
    },
    { kind: "move", selector: "canvas", defaults: { steps: 12, durationMs: 100 } },
  ])("normalizes omitted executor defaults for $kind", ({ defaults, ...action }) => {
    const journey = browserJourneySchema.parse({ url: "https://example.test", actions: [action] });
    const explicit = browserJourneySchema.parse({
      ...journey,
      actions: [{ ...action, ...defaults }],
    });
    expect(productJourneyKey(journey)).toBe(productJourneyKey(explicit));
  });

  it("accepts an actual before-input-after recording without asserting product quality", () => {
    expect(productJourneyGaps(options)).toEqual([]);
    expect(
      productJourneyGaps({ ...options, linkedEvidence: images.map((image) => image.path) }),
    ).toEqual([]);
  });
  it("requires completed status on new run records and preserves historical version-one readers", () => {
    expect(
      productJourneyGaps({
        ...options,
        captureRuns: [{ ...run, version: 2, status: "completed" }],
      }),
    ).toEqual([]);
    for (const status of [undefined, "failed", "timed-out", "cancelled"])
      expect(
        productJourneyGaps({ ...options, captureRuns: [{ ...run, version: 2, status }] }),
      ).toHaveLength(1);
  });
  it.each(["touch", "keyboard"])("recognizes actual %s operations", (kind) => {
    expect(
      productJourneyGaps({
        ...options,
        captureRuns: [
          { ...run, operations: [run.operations[0], operation("input", kind), run.operations[2]] },
        ],
      }),
    ).toEqual([]);
  });
  it.each([
    {
      name: "navigation-only screenshot",
      runs: [{ ...run, operations: [operation("navigate", "navigate"), run.operations[0]] }],
    },
    {
      name: "printed booleans",
      runs: [
        { ...run, operations: [], interacted: true, capturedBefore: true, capturedAfter: true },
      ],
    },
    { name: "unattributed imported record", runs: [{ ...run, provenance: "agent-reported" }] },
    { name: "stale source", runs: [{ ...run, subjectDigest: "c".repeat(64) }] },
    { name: "legacy unversioned record", runs: [{ ...run, version: undefined }] },
    {
      name: "input before all captures",
      runs: [{ ...run, operations: [run.operations[1], run.operations[0], run.operations[2]] }],
    },
    {
      name: "unbound capture operation",
      runs: [
        {
          ...run,
          operations: [operation("initial", "capture"), run.operations[1], run.operations[2]],
        },
      ],
    },
    {
      name: "same capture replayed",
      runs: [
        {
          ...run,
          operations: [
            run.operations[0],
            run.operations[1],
            operation("final", "capture", "before"),
          ],
        },
      ],
    },
    {
      name: "duplicate operation identity",
      runs: [
        {
          ...run,
          operations: [run.operations[0], operation("initial", "pointer"), run.operations[2]],
        },
      ],
    },
  ])("keeps $name unresolved", ({ runs }) => {
    expect(productJourneyGaps({ ...options, captureRuns: runs })).toHaveLength(1);
  });
  it("rejects repeated operation IDs even after a complete-looking sequence", () => {
    expect(
      productJourneyGaps({
        ...options,
        captureRuns: [{ ...run, operations: [...run.operations, run.operations[1]] }],
      }),
    ).toHaveLength(1);
  });
  it("requires both current intact linked runner captures from that run", () => {
    for (const candidate of [
      { ...options, linkedEvidence: ["after"] },
      { ...options, images: images.slice(1) },
      { ...options, images: images.map((image) => ({ ...image, sha256: "d".repeat(64) })) },
      {
        ...options,
        images: images.map((image) => ({ ...image, provenance: "agent-supplied" as const })),
      },
      {
        ...options,
        captureRuns: [
          {
            ...run,
            captures: images.map((image) => ({ ...image, subjectDigest: "e".repeat(64) })),
          },
        ],
      },
    ])
      expect(productJourneyGaps(candidate)).toHaveLength(1);
  });
});
