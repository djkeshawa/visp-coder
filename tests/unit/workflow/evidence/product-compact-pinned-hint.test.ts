import { expect, it } from "vitest";
import { compactProductReply } from "../../../../src/workflow/product-compact-text.js";

const hint =
  'If a failing pinned test contradicts the request, do not edit it: visp done --dispute "<test name>" --reason "<quote the request sentence + why>". ' +
  "x".repeat(900);

it.each(["done", "accept"])("prints the pinned-test hint of %s as a plain line", (operation) => {
  const text = compactProductReply(
    operation,
    {
      feature: "001-two",
      passed: false,
      pinnedTests: { disputes: [{ test: "value", status: "open", note: "n" }], hint },
    },
    "cli",
  );
  // Whole and unescaped, not a truncated JSON string.
  expect(text).toContain(`\n${hint}\n`);
  const [summary] = (text ?? "").split("\n");
  expect(summary).toContain('"pinnedTests":{"disputes"');
  expect(summary).not.toContain("--dispute");
});

it("adds no line and no empty pinnedTests when there is no hint or report", () => {
  const without = compactProductReply("done", { feature: "001-two", passed: true }, "cli") ?? "";
  expect(without).not.toContain("pinnedTests");
  expect(without.split("\n")).toHaveLength(2);
  const onlyDisputes =
    compactProductReply(
      "done",
      { feature: "001-two", pinnedTests: { disputes: [{ test: "v", status: "open", note: "" }] } },
      "mcp",
    ) ?? "";
  expect(onlyDisputes.split("\n")).toHaveLength(2);
});
