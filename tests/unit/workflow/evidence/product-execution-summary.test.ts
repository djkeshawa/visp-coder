import { expect, it } from "vitest";
import {
  executionSummary,
  productCaptureRunSchema,
} from "../../../../src/workflow/product/evidence-references.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";

const execution = {
  id: "execution",
  check: "C1",
  command: "browser-journey /",
  captureRunId: "run",
  subjectDigest: "subject",
  contractDigest: "contract",
  task: "T1",
  status: "failed",
  output: '{"captures":["large duplicated receipt"],"failure":"printed assertion"}',
} as ProductRecord["state"]["executions"][number];
const run = productCaptureRunSchema.parse({
  id: "run",
  version: 2,
  provenance: "runner-executed",
  subjectDigest: "subject",
  contractDigest: "contract",
  task: "T1",
  status: "failed",
  captures: [],
  operations: [],
  failure: { kind: "behavior", message: "Save did not update the item", operationId: "op-save" },
});
it("keeps the actual runner failure and citation while removing duplicated receipt metadata", () => {
  const summary = executionSummary(execution, run);
  expect(summary).toContain("Save did not update the item");
  expect(summary).toContain("op-save");
  expect(summary).not.toContain("large duplicated receipt");
  expect(summary).not.toContain("printed assertion");
});
it("preserves raw command output without an intact matching runner binding", () => {
  for (const altered of [
    undefined,
    { ...run, id: "other" },
    { ...run, subjectDigest: "changed" },
    { ...run, contractDigest: "changed" },
    { ...run, task: "other" },
    { ...run, failure: undefined },
  ])
    expect(executionSummary(execution, altered)).toContain(execution.output);
});
it("describes successful execution without claiming product correctness", () => {
  const summary = executionSummary(
    { ...execution, status: "passed" },
    { ...run, status: "completed", failure: undefined },
  );
  expect(summary).toContain("completed");
  expect(summary).toContain("Images and observations are supplied separately");
  expect(summary).not.toContain("passed");
});
it("retains execution diagnostics when a completed browser run failed later validation", () => {
  expect(
    executionSummary(execution, { ...run, status: "completed", failure: undefined }),
  ).toContain(execution.output);
});
