import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ProductBrief,
  type ProductReviewBundle,
  type ProductVerification,
  updateProductBrief,
} from "../../../src/workflow/product/index.js";
import { moduleFeedback } from "../support/product-feedback.js";
import { productWorkspace } from "../support/product-workspace.js";
import type { TestWorkspace } from "../support/workspace.js";
import { runCli, runJson } from "./support/cli.js";

let workspace: TestWorkspace;
let brief: ProductBrief;
beforeEach(async () => {
  ({ workspace, brief } = await productWorkspace());
});
afterEach(async () => workspace?.destroy());
const stateBytes = () =>
  readFile(join(workspace.root, ".visp/features", brief.feature, "product-state.json"), "utf8");

describe("product evidence CLI", () => {
  it("returns actual failed command evidence and closes only after the public behavior is corrected", async () => {
    expect((await runJson(workspace.root, "work")).exitCode).toBe(0);
    const failed = await runJson<ProductVerification>(workspace.root, "done");
    expect(failed.exitCode).toBe(1);
    expect(failed.envelope.data).toMatchObject({ passed: false, closed: false });
    expect(failed.envelope.data?.executions[0]).toMatchObject({
      status: "failed",
      provenance: "supervisor-executed",
      assertions: "agent-reported",
    });
    expect(failed.envelope.data?.executions[0]?.output).toContain("AssertionError");
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    const done = await runJson<ProductVerification>(workspace.root, "done");
    expect(done.envelope.data).toMatchObject({ passed: true, closed: true });
    const review = await runJson<ProductReviewBundle>(workspace.root, "review");
    if (!review.envelope.data) throw new Error("Missing review bundle");
    await workspace.write(
      ".visp/review.json",
      JSON.stringify({
        subjectDigest: review.envelope.data?.subjectDigest,
        feedback: moduleFeedback(review.envelope.data),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary:
              "The module exports two and the executable imported-value assertion distinguishes the original failure from the correction.",
            evidence: review.envelope.data?.executions.map((execution) => execution.id),
          },
        ],
      }),
    );
    expect((await runJson(workspace.root, "review", "--from", ".visp/review.json")).exitCode).toBe(
      0,
    );
    const accepted = await runJson<ProductVerification>(workspace.root, "accept");
    expect(accepted.envelope.data?.passed).toBe(true);
    const report = await runCli(workspace.root, "pr");
    expect(report.stdout).toContain("The public value is two");
    expect(report.stdout).toContain("passed");
  });

  it("refuses closure without work authorization and never executes an unknown task", async () => {
    const before = await stateBytes();
    expect((await runJson(workspace.root, "done")).exitCode).not.toBe(0);
    const unknown = await runJson(workspace.root, "verify", "--task", "T999");
    expect(unknown.envelope.error?.code).toBe("TASK_NOT_FOUND");
    expect(await stateBytes()).toBe(before);
  });

  it("preserves the distinction between a product failure and unavailable execution", async () => {
    const changed = await updateProductBrief(await workspace.state(), {
      brief: {
        ...brief,
        checks: brief.checks.map((check) => ({
          ...check,
          command: ["visp-nonexistent-test-program"],
        })),
      },
      reason: "Exercise unavailable runner",
    });
    expect(changed.ok).toBe(true);
    expect((await runJson(workspace.root, "work")).exitCode).toBe(0);
    const result = await runJson<ProductVerification>(workspace.root, "verify");
    expect(result.exitCode).toBe(1);
    expect(result.envelope.data?.executions[0]?.status).toBe("environment-failed");
    expect(result.envelope.data?.passed).toBe(false);
  });

  it("review reads a bundle without writing and rejects missing or stale subject submissions", async () => {
    const before = await stateBytes();
    const review = await runJson<ProductReviewBundle>(workspace.root, "review");
    expect(review.envelope.data?.subjectDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await stateBytes()).toBe(before);
    await workspace.write(
      ".visp/review.json",
      JSON.stringify({
        subjectDigest: "outdated",
        assessments: [
          { outcome: "O001", status: "satisfied", summary: "Inspected the behavior", evidence: [] },
        ],
      }),
    );
    const stale = await runJson(workspace.root, "review", "--from", ".visp/review.json");
    expect(stale.envelope.error?.code).toBe("EVIDENCE_FAILED");
    await workspace.write(".visp/review.json", "{}\n");
    expect(
      (await runJson(workspace.root, "review", "--from", ".visp/review.json")).envelope.error?.code,
    ).toBe("ARTIFACT_INVALID");
    expect(await stateBytes()).toBe(before);
  });

  it("refuses retired skip/staged/base options without executing or mutating", async () => {
    const before = await stateBytes();
    for (const args of [
      ["verify", "--skip-commands"],
      ["review", "--staged"],
      ["verify", "--base", "HEAD"],
      ["brief", "--task", "T999"],
      ["migrate", "--task", "T999"],
    ]) {
      const result = await runCli(workspace.root, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown option");
    }
    expect(await stateBytes()).toBe(before);
  });
});
