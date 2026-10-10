import { describe, expect, it } from "vitest";
import { outputHeadline, stripAnsi } from "../../../src/ui/output.js";

const nodeTestPass = [
  "✔ report has a header (0.9ms)",
  "ℹ tests 1",
  "ℹ suites 0",
  "ℹ pass 1",
  "ℹ fail 0",
  "ℹ duration_ms 61.2",
].join("\n");

const nodeTestFail = [
  "✖ cells with commas are quoted (1.6ms)",
  "ℹ tests 1",
  "ℹ pass 0",
  "ℹ fail 1",
  "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
].join("\n");

describe("outputHeadline", () => {
  it("names the pass count for a passing run, never its zero-failure line", () => {
    expect(outputHeadline(nodeTestPass, "passed")).toBe("pass 1");
  });

  it("names the first failure for a failing run", () => {
    expect(outputHeadline(nodeTestFail, "failed")).toBe("cells with commas are quoted (1.6ms)");
  });

  it("skips summary lines that report zero failures when looking for the failure", () => {
    expect(outputHeadline("ℹ fail 0\n0 failed\nError: port 3000 in use", "failed")).toBe(
      "Error: port 3000 in use",
    );
  });

  it("falls back to the last line the command printed", () => {
    expect(outputHeadline("building\nwrote dist/app.js\n", "passed")).toBe("wrote dist/app.js");
    expect(outputHeadline("", "environment-failed")).toBe("");
  });

  it("strips terminal colour codes and shortens very long lines", () => {
    expect(outputHeadline("\u001b[31mError: boom\u001b[0m", "failed")).toBe("Error: boom");
    const long = `Error: ${"x".repeat(400)}`;
    const headline = outputHeadline(long, "failed");
    expect(headline).toHaveLength(200);
    expect(headline.endsWith("…")).toBe(true);
  });
});

it("removes colour and cursor sequences without touching text", () => {
  expect(stripAnsi("\u001b[1m\u001b[32mok\u001b[0m 1 - works")).toBe("ok 1 - works");
});
