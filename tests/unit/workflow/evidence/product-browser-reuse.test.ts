import { expect, it } from "vitest";
import { reusableRun } from "../../../../src/workflow/product/browser-check-execution.js";

const run = (overrides: Record<string, unknown> = {}) => ({
  id: "CAPRUN-1",
  provenance: "runner-executed",
  status: "completed",
  subjectDigest: "subject",
  journeyKey: "journey",
  comparisonEnvironment: "environment-a",
  ...overrides,
});

it("reuses a completed capture of the same subject, journey and comparison environment", () => {
  expect(reusableRun([run()], "subject", "journey", "environment-a")).toEqual({ id: "CAPRUN-1" });
});

it("captures again under a different browser or toolchain", () => {
  expect(reusableRun([run()], "subject", "journey", "environment-b")).toBeUndefined();
});

it("never reuses a capture whose environment was not recorded or cannot be determined", () => {
  expect(
    reusableRun([run({ comparisonEnvironment: undefined })], "subject", "journey", undefined),
  ).toBeUndefined();
  expect(reusableRun([run()], "subject", "journey", undefined)).toBeUndefined();
  expect(
    reusableRun([run({ comparisonEnvironment: undefined })], "subject", "journey", "environment-a"),
  ).toBeUndefined();
});

it("keeps the existing subject, journey, status and provenance requirements", () => {
  for (const override of [
    { subjectDigest: "other" },
    { journeyKey: "other" },
    { status: "failed" },
    { provenance: "supervisor-reused" },
  ])
    expect(reusableRun([run(override)], "subject", "journey", "environment-a")).toBeUndefined();
});
