import { expect, it } from "vitest";
import { reviewCommand } from "../../../src/cli/commands/product.js";

it("explains current evidence IDs, JSON submissions and stale draft boundaries", () => {
  let output = "";
  reviewCommand()
    .configureOutput({
      writeOut: (text) => {
        output += text;
      },
    })
    .outputHelp();

  expect(output).toContain("data.evidence and data.sources");
  expect(output).toContain("Keep subjectDigest and selection");
  expect(output).toContain("C001 resolve only after the declared check has executed");
  expect(output).toContain("Submit the editable data object, not the --json envelope");
  expect(output).toContain(".visp/drafts/review.json");
  expect(output).toContain("make a previous review stale");
  expect(output).toContain("reviewer.context=current");
  expect(output).toContain("Do not submit canned satisfied judgments");
});
