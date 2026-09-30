import type { Command } from "commander";
import { expect, it } from "vitest";
import { acceptCommand, doneCommand, reviewCommand } from "../../../src/cli/commands/product.js";

function helpOf(command: Command) {
  let output = "";
  command
    .configureOutput({
      writeOut: (text) => {
        output += text;
      },
    })
    .outputHelp();
  return output;
}

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

it.each([
  ["done", doneCommand],
  ["accept", acceptCommand],
])(
  "says VISP launches the reviewer for a dispute on %s, and that the worker delegates nothing",
  (_name, command) => {
    const output = helpOf(command());
    expect(output).toContain("--dispute");
    expect(output).toContain("VISP starts the independent reviewer during the command");
    expect(output).toContain("you never delegate it");
  },
);

it("sends the worker to the review only when next prints it, and never to a self-review", () => {
  const output = helpOf(reviewCommand());
  expect(output).toContain("Run only when `visp next` prints a review command.");
  expect(output).toContain("If `visp done` runs VISP's own");
  expect(output).toContain("a review you write yourself is not the independent review");
  expect(output).not.toContain("Prefer visp review --prepare");
  expect(output).toContain(
    "When next printed the review command, --dispatch needs an attached host",
  );
  // What a host-delegated worker needs once next does print the command is kept.
  expect(output).toContain("--session <id> --from -");
  expect(output).toContain("do\nnot add subjectDigest, selection or captures");
});
