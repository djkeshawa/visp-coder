import { describe, expect, it } from "vitest";
import {
  contextManifestSchema,
  contextPackSchema,
} from "../../../../src/workflow/artifacts/context.js";
import {
  flipCheckSchema,
  verificationSchema,
} from "../../../../src/workflow/artifacts/evidence.js";

const HASH = "a".repeat(64);

/** A pack written before regions, omitted and attemptFeedback existed. */
const OLD_PACK = {
  kind: "context",
  createdAt: "2026-08-01T00:00:00.000Z",
  feature: "001-add-login",
  task: "T001",
  goal: "Add the login handler",
  files: [
    {
      path: "src/auth/login.ts",
      reason: "expected-file",
      hash: HASH,
      snippets: [{ startLine: 1, endLine: 3, text: "export const login = 1;" }],
      truncated: false,
    },
  ],
  entrypoints: [],
  unknowns: [],
  estimatedTokens: 12,
  tokenBudget: 12000,
  graphAvailable: true,
};

describe("context pack schema compatibility", () => {
  it("parses a pack written before the reading-plan fields existed", () => {
    const parsed = contextPackSchema.parse(OLD_PACK);

    expect(parsed.files[0]?.regions).toEqual([]);
    expect(parsed.files[0]?.estimatedTokens).toBe(0);
    expect(parsed.omitted).toEqual([]);
    expect(parsed.attemptFeedback).toBeUndefined();
  });

  it("still rejects a key it does not know", () => {
    expect(() => contextPackSchema.parse({ ...OLD_PACK, surprise: true })).toThrow();
  });
});

describe("context manifest schema compatibility", () => {
  it("parses a manifest written before graph snapshot binding existed", () => {
    const parsed = contextManifestSchema.parse({
      kind: "context-manifest",
      createdAt: "2026-08-01T00:00:00.000Z",
      feature: "001-add-login",
      task: "T001",
      sources: [],
      contextHash: HASH,
    });

    expect(parsed.graphSnapshotId).toBeUndefined();
  });
});

describe("verification schema compatibility", () => {
  const OLD_VERIFICATION = {
    kind: "verification",
    createdAt: "2026-08-01T00:00:00.000Z",
    feature: "001-add-login",
    task: "T001",
    passed: true,
    codeEvidence: "executed",
    commands: [],
    changedFiles: [],
    findings: [],
  };

  it("parses a record written before attempt, delta and flip existed", () => {
    const parsed = verificationSchema.parse(OLD_VERIFICATION);

    expect(parsed.attempt).toBeUndefined();
    expect(parsed.delta).toBeUndefined();
    expect(parsed.flip).toBeUndefined();
  });
});

describe("flip check contract", () => {
  it("refuses an unchecked flip that does not say why", () => {
    expect(() =>
      flipCheckSchema.parse({ failsWithoutChange: "unchecked", revertedFiles: [], commands: [] }),
    ).toThrow();
  });

  it("accepts an unchecked flip with its reason", () => {
    const parsed = flipCheckSchema.parse({
      failsWithoutChange: "unchecked",
      reason: "task declares no validation commands to flip",
    });
    expect(parsed.failsWithoutChange).toBe("unchecked");
  });

  it("accepts a not-applicable flip with its reason", () => {
    const parsed = flipCheckSchema.parse({
      failsWithoutChange: "not-applicable",
      reason: "only validation files changed",
    });
    expect(parsed.failsWithoutChange).toBe("not-applicable");
  });

  it("refuses a not-applicable flip without its reason", () => {
    expect(() => flipCheckSchema.parse({ failsWithoutChange: "not-applicable" })).toThrow();
  });

  it("accepts a boolean answer without a reason", () => {
    const parsed = flipCheckSchema.parse({ failsWithoutChange: true });
    expect(parsed.failsWithoutChange).toBe(true);
    expect(parsed.preservedValidationFiles).toEqual([]);
    expect(parsed.signal).toBeUndefined();
  });
});
