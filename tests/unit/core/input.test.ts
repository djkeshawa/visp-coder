import { describe, expect, it } from "vitest";
import {
  parseFeatureId,
  parseFeatureStart,
  parseHarness,
  parseHookKind,
  parseProfile,
  parseProjectFilePath,
  parseRiskLevel,
  parseTaskId,
} from "../../../src/core/input.js";

describe("typed command inputs", () => {
  it.each([
    [parseHarness, "unknown"],
    [parseProfile, "huge"],
    [parseHookKind, "editor"],
    [parseRiskLevel, "extreme"],
  ] as const)("returns UNSUPPORTED for an unknown enum", (parse, value) => {
    const result = parse(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED");
  });

  it.each([
    [parseFeatureId, "../outside"],
    [parseFeatureId, "/tmp/001-outside"],
    [parseTaskId, "../../T001"],
    [parseTaskId, "task-1"],
  ] as const)("returns ARTIFACT_INVALID for a malformed identifier", (parse, value) => {
    const result = parse(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ARTIFACT_INVALID");
  });

  it("checks the feature risk before the deprecated workflow mode", () => {
    expect(parseFeatureStart(undefined, undefined)).toEqual({ ok: true, value: "low" });
    expect(parseFeatureStart("high", "compact")).toEqual({ ok: true, value: "high" });
    const risk = parseFeatureStart("extreme", "bogus");
    expect(!risk.ok && risk.error.message).toContain("risk level");
    const mode = parseFeatureStart("medium", "bogus");
    expect(!mode.ok && mode.error.message).toContain("workflow mode");
  });

  it("returns narrowed values for valid inputs", () => {
    expect(parseHarness("codex")).toEqual({ ok: true, value: "codex" });
    expect(parseProfile("minimal")).toEqual({ ok: true, value: "minimal" });
    expect(parseHookKind("git")).toEqual({ ok: true, value: "git" });
    expect(parseRiskLevel("high")).toEqual({ ok: true, value: "high" });
    expect(parseFeatureId("001-safe-feature")).toEqual({ ok: true, value: "001-safe-feature" });
    expect(parseTaskId("T001")).toEqual({ ok: true, value: "T001" });
    expect(parseProjectFilePath("./receipts/probe.json")).toEqual({
      ok: true,
      value: "receipts/probe.json",
    });
    expect(parseProjectFilePath("receipts\\probe.json")).toEqual({
      ok: true,
      value: "receipts/probe.json",
    });
  });

  it.each([
    "../outside.json",
    "nested/../../outside.json",
    "/tmp/outside.json",
    "C:\\temp\\outside.json",
    "\\\\server\\share\\outside.json",
    "",
    ".",
    "folder/",
    "bad\0name.json",
  ])("rejects a non-confined file argument: %s", (value) => {
    const result = parseProjectFilePath(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ARTIFACT_INVALID");
  });
});
