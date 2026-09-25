import { describe, expect, it } from "vitest";
import {
  buildContainerArguments,
  evaluateReport,
  evaluatorSpecSchema,
} from "../../../src/runner/evaluator.js";

const policy = {
  schemaVersion: 1 as const,
  id: "check",
  image: `example/evaluator@sha256:${"a".repeat(64)}`,
  engine: {
    executable: "/usr/bin/docker",
    executableSha256: "b".repeat(64),
    version: "Docker fixture",
  },
  policyDirectory: "/trusted/evaluator",
  policyHash: "c".repeat(64),
  command: ["/evaluator/run", "--source", "/candidate"],
  format: "vitest" as const,
  reportFile: "report.json",
  requiredTests: ["a.test.ts::rejects invalid input"],
  timeoutMs: 30000,
  uid: 1000,
  gid: 1000,
};

describe("pinned independent evaluator", () => {
  it("requires a digest-pinned image and evaluator commands outside candidate control", () => {
    expect(evaluatorSpecSchema.safeParse(policy).success).toBe(true);
    expect(
      evaluatorSpecSchema.safeParse({ ...policy, image: "example/evaluator:latest" }).success,
    ).toBe(false);
    expect(
      evaluatorSpecSchema.safeParse({ ...policy, command: ["/candidate/check"] }).success,
    ).toBe(false);
    expect(evaluatorSpecSchema.safeParse({ ...policy, reportFile: "../forged.json" }).success).toBe(
      false,
    );
  });

  it("denies network, secrets, privilege escalation, and writes to source or oracle", () => {
    const args = buildContainerArguments(policy, "/runs/eval", "visp-owned", "d".repeat(64));
    expect(args).toContain("--read-only");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("none");
    expect(args.join(" ")).toContain("dst=/evaluator,readonly");
    expect(args.join(" ")).toContain("dst=/candidate,readonly");
    expect(args.join(" ")).not.toContain("dst=/results");
    expect(args).toContain("/results:rw,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700");
    expect(args).not.toContain("--env-file");
    expect(args).not.toContain("--privileged");
    expect(args).toContain(policy.image);
  });

  it("gives the configured nonroot evaluator ownership of its writable temporary storage", () => {
    const args = buildContainerArguments(
      { ...policy, uid: 1234, gid: 2345 },
      "/runs/eval",
      "visp-owned",
      "d".repeat(64),
    );
    expect(args[args.indexOf("--user") + 1]).toBe("1234:2345");
    expect(args).toContain("/scratch:rw,nosuid,nodev,size=1g,uid=1234,gid=2345,mode=0700");
    expect(args).toContain("/results:rw,nosuid,nodev,size=16m,uid=1234,gid=2345,mode=0700");
  });

  it("requires every pinned acceptance test to execute and pass", () => {
    const report = {
      success: true,
      testResults: [
        {
          name: "a.test.ts",
          assertionResults: [
            { fullName: "rejects invalid input", status: "pending" },
            { fullName: "accepts valid input", status: "passed" },
          ],
        },
      ],
    };
    expect(evaluateReport(policy, report, 0)).toMatchObject({
      accepted: false,
      unmetTests: ["a.test.ts::rejects invalid input"],
    });
    expect(
      evaluateReport({ ...policy, requiredTests: ["a.test.ts::accepts valid input"] }, report, 0)
        .accepted,
    ).toBe(true);
    expect(
      evaluateReport({ ...policy, requiredTests: ["a.test.ts::accepts valid input"] }, report, 1)
        .accepted,
    ).toBe(false);
  });
});
