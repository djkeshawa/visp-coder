import { expect, it } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import { browserJourneySchema } from "../../../../src/testing/browser-journey.js";
import { productJourneyKey } from "../../../../src/workflow/evidence/product-journey.js";
import {
  currentFailedJourneys,
  pendingJourneyReplays,
} from "../../../../src/workflow/product/evidence-references.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";

function fixture() {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-history",
    originalRequest: "Hold the control",
    goal: "Hold the control",
    slices: [{ id: "T001", goal: "Hold", scope: { allowed: ["index.html"] } }],
  });
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: initialProductState(brief, "now"),
  };
  const journey = browserJourneySchema.parse({
    url: "http://localhost:3000",
    actions: [
      {
        kind: "drag",
        selector: "#control",
        from: { x: 10, y: 10 },
        to: { x: 10, y: 10 },
        durationMs: 80,
      },
    ],
  });
  const legacyKey = (input: typeof journey) =>
    `journey-v2:${hashValue({ url: input.url, viewport: input.viewport ?? { width: 1280, height: 720 }, task: "T001", actions: input.actions.map((action) => Object.fromEntries(Object.entries(action).filter(([key]) => !["capture", "timeoutMs", "steps", "captureDuring"].includes(key) && (key !== "durationMs" || action.kind === "wait")))) })}`;
  const failed = {
    id: "old-failure",
    version: 2,
    provenance: "runner-executed",
    task: "T001",
    subjectDigest: "old",
    contractDigest: productContractDigest(brief, brief.slices[0]),
    journey,
    journeyDigest: hashValue(journey),
    journeyKey: legacyKey(journey),
    status: "timed-out",
    failure: { kind: "behavior", message: "Held input failed" },
    captures: [],
    operations: [],
  };
  record.state.captureRuns = [failed];
  return { record, failed, journey, legacyKey };
}

it("keeps an intact legacy failure pending after a source edit without rewriting history", () => {
  const f = fixture();
  const original = JSON.stringify(f.record.state);
  expect(pendingJourneyReplays(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
  expect(JSON.stringify(f.record.state)).toBe(original);
});

it("does not let the old timing-colliding passing gesture hide a longer failure", () => {
  const f = fixture();
  const shorter = browserJourneySchema.parse({
    ...f.journey,
    actions: [{ ...f.journey.actions[0], durationMs: 0 }],
  });
  f.record.state.captureRuns.push({
    ...f.failed,
    id: "old-short-pass",
    subjectDigest: "new",
    status: "completed",
    failure: undefined,
    journey: shorter,
    journeyDigest: hashValue(shorter),
    journeyKey: f.legacyKey(shorter),
  });
  expect(currentFailedJourneys(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
  expect(pendingJourneyReplays(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
});

it("clears the replay requirement only after a current execution of the recorded full input", () => {
  const f = fixture();
  f.record.state.captureRuns.push({
    ...f.failed,
    id: "fresh-replay",
    subjectDigest: "new",
    status: "completed",
    failure: undefined,
    journeyKey: productJourneyKey(f.journey, "T001"),
  });
  expect(currentFailedJourneys(f.record, "new", "T001")).toEqual([]);
  expect(pendingJourneyReplays(f.record, "new", "T001")).toEqual([]);
});

it("does not upgrade an old passing receipt into current replay credit", () => {
  const f = fixture();
  f.record.state.captureRuns.push({
    ...f.failed,
    id: "legacy-pass",
    subjectDigest: "new",
    status: "completed",
    failure: undefined,
  });
  expect(currentFailedJourneys(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
  expect(pendingJourneyReplays(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
});

it("does not clear a historical failure with a tampered current replay", () => {
  const f = fixture();
  f.record.state.captureRuns.push({
    ...f.failed,
    id: "tampered",
    subjectDigest: "new",
    status: "completed",
    failure: undefined,
    journeyDigest: "tampered",
    journeyKey: productJourneyKey(f.journey, "T001"),
  });
  expect(currentFailedJourneys(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
  expect(pendingJourneyReplays(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
});
