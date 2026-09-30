import { expect, it } from "vitest";
import { earlierAssertionResults } from "../../../../src/workflow/product/review-check-output.js";

it("retains named unittest, TAP and pinned results before verbose log tails", () => {
  const text = [
    "test_retired (tests.Api) ... ok",
    "test_invalid (tests.Api) ... FAIL",
    "# Subtest: a value",
    "ok 1 - a value",
    "PASS: docs updated",
    "noise\n".repeat(3000),
  ].join("\n");
  const result = earlierAssertionResults(text, 3000);
  for (const name of ["test_retired", "test_invalid", "ok 1 - a value", "PASS: docs updated"])
    expect(result).toContain(name);
  expect(result).toContain("output shortened");
  expect(result.length).toBeLessThanOrEqual(2000);
});
it("discloses omitted names without manufacturing results for silent checks", () => {
  const result = earlierAssertionResults(
    `${Array.from({ length: 100 }, (_, i) => `PASS: assertion ${i}`).join("\n")}\n${"noise\n".repeat(3000)}`,
    2000,
    700,
  );
  expect(result).toContain("omitted");
  expect(result.length).toBeLessThanOrEqual(700);
  expect(earlierAssertionResults("no named assertions\n".repeat(1000), 3000)).toBe("");
});
