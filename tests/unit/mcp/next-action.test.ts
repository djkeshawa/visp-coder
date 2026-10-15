import { describe, expect, it } from "vitest";
import { mcpAction, mcpActionFor } from "../../../src/mcp/action.js";
import { cliCommand, nextAction, renderCli } from "../../../src/workflow/next-action.js";

// Each row is a command line a workflow step used to format by hand.
const LINES: [string, ReturnType<typeof nextAction>][] = [
  ["visp work --feature 001-x --task T001", nextAction("work", { feature: "001-x", task: "T001" })],
  ["visp work --feature 001-x", nextAction("work", { feature: "001-x", task: undefined })],
  ["visp work --feature 001-x", nextAction("work", { feature: "001-x", task: "" })],
  [
    "visp review --handoff --feature 001-x --task T002",
    nextAction("review", { handoff: true, feature: "001-x", task: "T002" }),
  ],
  [
    "visp review --feature 001-x --task T002 --handoff",
    nextAction("review", { feature: "001-x", task: "T002", handoff: true }),
  ],
  [
    "visp review --feature 001-x --session s1 --from -",
    nextAction("review", { feature: "001-x", session: "s1", from: "-" }),
  ],
  [
    "visp capture --feature 001-x --task T001 --replay=run-1",
    nextAction("capture", { feature: "001-x", task: "T001", replay: { joined: "run-1" } }),
  ],
  [
    "visp capture --feature 001-x --replay-batch=run-1",
    nextAction("capture", { feature: "001-x", "replay-batch": { joined: "run-1" } }),
  ],
  [
    'visp work --feature 001-x --check "<command that runs your tests>"',
    nextAction("work", { feature: "001-x", check: { quoted: "<command that runs your tests>" } }),
  ],
  [
    "visp critic feedback --feature 001-x --id q1 --reply",
    nextAction("critic", { feature: "001-x", id: "q1", reply: true }, ["feedback"]),
  ],
  [
    "visp critic --feature 001-x --task T001 --phase product",
    nextAction("critic", { feature: "001-x", task: "T001", phase: "product" }),
  ],
  ['visp feature "<goal>"', nextAction("feature", {}, [{ quoted: "<goal>" }])],
];

describe("next actions", () => {
  it.each(LINES)("renders %s", (line, action) => {
    expect(renderCli(action)).toBe(line);
  });

  it.each(LINES)("gives MCP the same call from the structure as from %s", (line, action) => {
    expect(mcpActionFor(action)).toEqual(mcpAction(line));
  });

  it("has a shorthand that renders the same line", () => {
    expect(cliCommand("done", { feature: "001-x", task: "T001" })).toBe(
      "visp done --feature 001-x --task T001",
    );
  });
});
