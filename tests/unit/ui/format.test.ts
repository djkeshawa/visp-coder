import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { UiNext } from "../../../src/ui/contract.js";
import {
  currentStage,
  describeNext,
  executionTone,
  executionWord,
  isFailureLine,
  runShape,
  STAGES,
  shellQuote,
  withQuotedAnswer,
} from "../../../ui/src/format.js";

describe("shellQuote", () => {
  it.each([
    "plain answer",
    "Don't expand $HOME or `ls` or $(whoami)",
    "two\nlines",
    "'",
    "",
    'back\\slash and "double" quotes',
  ])("round-trips %j through a POSIX shell unchanged", (text) => {
    const echoed = execFileSync("sh", ["-c", `printf %s ${shellQuote(text)}`], {
      encoding: "utf8",
    });
    expect(echoed).toBe(text);
  });

  it("appends the quoted answer to the reply command", () => {
    expect(withQuotedAnswer("visp critic feedback --id X --reply", "it's fine")).toBe(
      "visp critic feedback --id X --reply 'it'\\''s fine'",
    );
  });
});

describe("describeNext", () => {
  const next = (overrides: Partial<UiNext>): UiNext => ({
    action: "implement",
    objective: "",
    mayEdit: true,
    evidence: [],
    ...overrides,
  });

  it("describes the action, not the completion, while work continues", () => {
    expect(describeNext(next({ action: "fix", completion: "unresolved-product" })).headline).toBe(
      "Fixing what failed",
    );
  });

  it("says when the work is handed to a person or blocked by the environment", () => {
    expect(describeNext(next({ action: "refine", completion: "handoff" })).headline).toBe(
      "Handed over to you",
    );
    expect(describeNext(next({ completion: "unresolved-environment" })).tone).toBe("warn");
  });

  it("distinguishes building from being ready to build", () => {
    expect(describeNext(next({ mayEdit: true })).headline).toBe("Building");
    expect(describeNext(next({ mayEdit: false })).headline).toBe("Ready to build");
  });
});

it("highlights failure lines but not zero-failure summaries", () => {
  expect(isFailureLine("✖ cells are quoted")).toBe(true);
  expect(isFailureLine("AssertionError: expected 1")).toBe(true);
  expect(isFailureLine("ℹ fail 0")).toBe(false);
  expect(isFailureLine("12 passed, 0 failed")).toBe(false);
  expect(isFailureLine("ℹ pass 3")).toBe(false);
});

describe("currentStage", () => {
  const next = (fields: Partial<UiNext>): UiNext => ({
    action: "implement",
    objective: "",
    mayEdit: true,
    evidence: [],
    ...fields,
  });

  it.each([
    [{ action: "understand" }, "Brief", "shaping"],
    [{ action: "implement" }, "Implement", "building"],
    [{ action: "fix" }, "Checks", "fixing"],
    [{ action: "wait" }, "Review", "running"],
    [{ action: "refine" }, "Review", "answering"],
    [{ action: "accept" }, "Accept", "ready"],
    [{ action: "fix", completion: "unresolved-environment" }, "Checks", "blocked"],
    [{ action: "refine", completion: "handoff" }, "Handoff", "to you"],
  ] as const)("places %o at %s (%s)", (fields, stage, detail) => {
    const placed = currentStage(next(fields), false);
    expect(STAGES[placed.index]).toBe(stage);
    expect(placed.detail).toBe(detail);
  });

  it("marks every stage done once the feature is accepted", () => {
    expect(currentStage(next({ action: "fix" }), true).index).toBe(STAGES.length);
    expect(currentStage(next({ action: "complete" }), false).index).toBe(STAGES.length);
  });
});

describe("run status words and shapes", () => {
  it("gives every status its own shape and word, and a timeout reads as a failure", () => {
    const statuses = ["passed", "failed", "timed-out", "environment-failed"] as const;
    expect(new Set(statuses.map(runShape)).size).toBe(statuses.length);
    expect(new Set(statuses.map(executionWord)).size).toBe(statuses.length);
    expect(executionTone("timed-out")).toBe("bad");
    expect(executionTone("environment-failed")).toBe("warn");
  });
});
