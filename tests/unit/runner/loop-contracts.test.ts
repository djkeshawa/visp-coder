import { expect, it } from "vitest";
import { parseLoopReview } from "../../../src/runner/loop-contracts.js";

const subject = "a".repeat(64);
const criteria = [{ id: "launch" }];
const pass = {
  subjectDigest: subject,
  decision: "pass",
  checks: [
    {
      id: "launch",
      status: "passed",
      exercise: "drag, hit, settle, shoot again",
      observed: "Both shots score",
      evidence: ["CAPRUN-1"],
    },
  ],
  findings: [],
};
it.each([
  { ...pass, subjectDigest: "b".repeat(64) },
  { ...pass, checks: [] },
  { ...pass, checks: [...pass.checks, ...pass.checks] },
  { ...pass, checks: [{ ...pass.checks[0], status: "unverified" }] },
  { ...pass, checks: [{ ...pass.checks[0], evidence: [] }] },
  { ...pass, decision: "repair" },
])("rejects an unsupported review decision %#", (review) => {
  expect(() => parseLoopReview(JSON.stringify(review), subject, criteria)).toThrow();
});

it("requires repair feedback to address a failed criterion", () => {
  const review = {
    ...pass,
    decision: "repair",
    checks: [
      { ...pass.checks[0], status: "failed" },
      { ...pass.checks[0], id: "other" },
    ],
    findings: [
      { criterion: "other", problem: "Polish the passing helper", nextCheck: "Read the helper" },
    ],
  };
  expect(() =>
    parseLoopReview(JSON.stringify(review), subject, [...criteria, { id: "other" }]),
  ).toThrow("concrete failure");
});

it("does not substitute a helper-only exercise for a previously failing public interaction", () => {
  const failure = parseLoopReview(
    JSON.stringify({
      ...pass,
      decision: "repair",
      checks: [{ ...pass.checks[0], status: "failed" }],
      findings: [
        {
          criterion: "launch",
          problem: "Second shot is stuck",
          nextCheck: "Replay the same second shot",
        },
      ],
    }),
    subject,
    criteria,
  );
  expect(() =>
    parseLoopReview(
      JSON.stringify({
        ...pass,
        checks: [{ ...pass.checks[0], exercise: "unit-test helper default" }],
      }),
      subject,
      criteria,
      [failure],
    ),
  ).toThrow("same failing exercise");
  expect(parseLoopReview(JSON.stringify(pass), subject, criteria, [failure]).decision).toBe("pass");
  const evidence = parseLoopReview(
    JSON.stringify({
      ...pass,
      decision: "evidence",
      checks: [{ ...pass.checks[0], status: "unverified", evidence: [] }],
    }),
    subject,
    criteria,
    [failure],
  );
  expect(() =>
    parseLoopReview(
      JSON.stringify({
        ...pass,
        checks: [{ ...pass.checks[0], exercise: "unit-test helper default" }],
      }),
      subject,
      criteria,
      [failure, evidence],
    ),
  ).toThrow("same failing exercise");
});
