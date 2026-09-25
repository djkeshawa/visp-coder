import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertionReceipts,
  runValidationCommands,
} from "../../../../src/workflow/evidence/commands.js";

/**
 * The evidence claim rests entirely on this: what ran, what did not, and never
 * mistaking one for the other.
 */

let cwd = "";

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "visp-commands-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const succeeds = ["node", "-e", "process.exit(0)"];
const fails = ["node", "-e", "process.exit(3)"];

describe("runValidationCommands", () => {
  it("retains executed checkpoint receipts and fails malformed or failed evidence despite exit zero", async () => {
    const receipt = {
      criterion: "AC001",
      id: "held",
      kind: "checkpoint",
      surface: "data",
      outcome: "passed",
      samples: 2,
    };
    for (const [value, passed] of [
      [JSON.stringify(receipt), true],
      [JSON.stringify({ ...receipt, outcome: "failed" }), false],
      ["{broken}", false],
    ] as const) {
      const result = await runValidationCommands(
        [["node", "-e", `console.log(${JSON.stringify(`VISP_EVIDENCE ${value}`)})`]],
        cwd,
      );
      expect(result.passed).toBe(passed);
      if (passed) expect(result.results[0]?.evidenceReceipts).toEqual([receipt]);
    }
  });
  it("reads anchored TAP diagnostic receipts while preserving contradictory failures", () => {
    expect(
      assertionReceipts(
        "# VISP_ASSERT AC001 passed\n# VISP_ASSERT AC001 failed\n# example VISP_ASSERT AC002 passed\n# VISP_ASSERT AC003 passed",
      ),
    ).toEqual([
      { criterion: "AC001", outcome: "failed" },
      { criterion: "AC003", outcome: "passed" },
    ]);
  });
  it("refuses an all-skipped Playwright JSON report even with a success receipt", async () => {
    const report = {
      config: {},
      suites: [
        {
          specs: ["first", "second"].map((id) => ({
            id,
            tests: [
              { projectName: "browser", status: "skipped", results: [{ status: "skipped" }] },
            ],
          })),
        },
      ],
      errors: [],
      stats: {
        startTime: "2026-09-06T00:00:00Z",
        duration: 10,
        expected: 0,
        unexpected: 0,
        flaky: 0,
        skipped: 2,
      },
    };
    const outcome = await runValidationCommands(
      [
        [
          "node",
          "-e",
          `console.log(${JSON.stringify(JSON.stringify(report))}); console.error('VISP_ASSERT AC001 passed');`,
        ],
      ],
      cwd,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.results[0]).toMatchObject({
      failureKind: "no-tests",
      testSummary: { passed: 0, failed: 0, skipped: 2 },
    });
  });

  it("does not certify a successful runner that skipped every test", async () => {
    await writeFile(
      join(cwd, "skip.test.mjs"),
      "import { test } from 'node:test'; test('browser unavailable', { skip: true }, () => {});",
    );
    const outcome = await runValidationCommands(
      [["node", "--test", "--test-reporter=tap", "skip.test.mjs"]],
      cwd,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.results[0]).toMatchObject({
      exitCode: 0,
      failureKind: "no-tests",
      testSummary: { passed: 0, failed: 0, skipped: 1 },
    });
  });

  it("records partial skipped coverage without inventing a failed assertion", async () => {
    await writeFile(
      join(cwd, "mixed.test.mjs"),
      "import { test } from 'node:test'; test('runs', () => {}); test('optional', { skip: true }, () => {});",
    );
    const outcome = await runValidationCommands(
      [["node", "--test", "--test-reporter=tap", "mixed.test.mjs"]],
      cwd,
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.results[0]).toMatchObject({ testSummary: { passed: 1, failed: 0, skipped: 1 } });
  });

  it("refuses contradictory assertion receipts even when the runner exits zero", async () => {
    const outcome = await runValidationCommands(
      [["node", "-e", "console.log('VISP_ASSERT AC001 passed\\nVISP_ASSERT AC001 failed')"]],
      cwd,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.results[0]).toMatchObject({ failureKind: "assertion", exitCode: 0 });
  });

  it("reports nothing declared as delegated, not as a pass it verified", async () => {
    const outcome = await runValidationCommands([], cwd);

    expect(outcome.codeEvidence).toBe("delegated");
    expect(outcome.results).toEqual([]);
  });

  it("reports a clean run as executed", async () => {
    const outcome = await runValidationCommands([succeeds], cwd);

    expect(outcome.codeEvidence).toBe("executed");
    expect(outcome.passed).toBe(true);
    expect(outcome.unrunnable).toEqual([]);
  });

  it("fails on a non-zero exit while still counting the run as executed", async () => {
    const outcome = await runValidationCommands([fails], cwd);

    expect(outcome.codeEvidence).toBe("executed");
    expect(outcome.passed).toBe(false);
    expect(outcome.results[0]?.exitCode).toBe(3);
  });

  /** A command that never started is not a failing check; it is no check. */
  it("reports refused when nothing could run", async () => {
    const outcome = await runValidationCommands(["definitely-not-a-real-binary-xyz"], cwd);

    expect(outcome.codeEvidence).toBe("refused");
    expect(outcome.passed).toBe(false);
    expect(outcome.unrunnable).toEqual(["definitely-not-a-real-binary-xyz"]);
  });

  /**
   * The case that used to read as `executed`: something ran, so the run looked
   * complete, and the command that never started disappeared from the claim.
   */
  it("reports partial when only some could run", async () => {
    const outcome = await runValidationCommands([succeeds, "no-such-binary-xyz"], cwd);

    expect(outcome.codeEvidence).toBe("partial");
    expect(outcome.passed).toBe(false);
    expect(outcome.unrunnable).toEqual(["no-such-binary-xyz"]);
  });

  it("records invalid process arguments and continues the remaining checks", async () => {
    const outcome = await runValidationCommands([["node", "bad\0argument"], succeeds], cwd);

    expect(outcome).toMatchObject({
      codeEvidence: "partial",
      passed: false,
      results: [
        { exitCode: -1, passed: false },
        { exitCode: 0, passed: true },
      ],
    });
    expect(outcome.unrunnable).toHaveLength(1);
  });

  it("refuses a chained command rather than pretending to run it", async () => {
    const outcome = await runValidationCommands(["node -e 0 && node -e 1"], cwd);

    expect(outcome.codeEvidence).toBe("refused");
    expect(outcome.results[0]?.output).toContain("shell");
  });

  /** The argv form exists for arguments that only look like shell syntax. */
  it("runs an argv list without parsing it for shell syntax", async () => {
    const outcome = await runValidationCommands(
      [["node", "-e", "process.exit(0)", "--", "*"]],
      cwd,
    );

    expect(outcome.codeEvidence).toBe("executed");
    expect(outcome.passed).toBe(true);
  });

  it("records an argv list readably", async () => {
    const outcome = await runValidationCommands([succeeds], cwd);
    expect(outcome.results[0]?.command).toBe("node -e process.exit(0)");
  });

  it("extracts criterion assertion receipts from command output", async () => {
    const outcome = await runValidationCommands(
      [["node", "-e", "console.log('VISP_ASSERT AC001 passed')"]],
      cwd,
    );

    expect(outcome.results[0]?.assertedCriteria).toEqual([
      { criterion: "AC001", outcome: "passed" },
    ]);
  });

  it("treats an empty argv list as unrunnable", async () => {
    const outcome = await runValidationCommands([[""]], cwd);

    expect(outcome.codeEvidence).toBe("refused");
    expect(outcome.results[0]?.output).toContain("empty");
  });
});
