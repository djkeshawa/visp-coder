import { describe, expect, it } from "vitest";
import {
  mergeProjectRules,
  projectRulesText,
  standingRules,
  statedRules,
} from "../../../../src/workflow/product/project-rules.js";

// A user stated team conventions for "all later work, including future sessions". A fresh
// session with the next request applied none of them, although they were in VISP's records;
// restated in the request, the same worker applied all of them.
describe("standing rules in a user's prompt", () => {
  it("takes each listed rule after a statement that they outlive this request", () => {
    const prompt = [
      "This repository already contains a working API.",
      "",
      "Before the change: these are our team's API conventions. They apply to this change and to all later work on this service, including future sessions.",
      "",
      "Our API conventions:",
      "",
      "- C1 Lists. Every collection endpoint is paginated.",
      "- C3 Money. An amount of money is an integer number of cents.",
      "",
      "The change:",
      "",
      "1. New `GET /v1/items` lists items.",
    ].join("\n");
    expect(standingRules(prompt)).toEqual([
      "C1 Lists. Every collection endpoint is paginated.",
      "C3 Money. An amount of money is an integer number of cents.",
    ]);
  });

  it("takes a one-sentence standing rule", () => {
    expect(
      standingRules("Add a search box.\n\nFrom now on, never log request bodies. Thanks!"),
    ).toEqual(["From now on, never log request bodies."]);
  });

  it("takes a list introduced in the same paragraph", () => {
    expect(
      standingRules("Going forward, for every change:\n* run the linter\n* keep the changelog"),
    ).toEqual(["run the linter", "keep the changelog"]);
  });

  // Review: a task list under an unrelated heading is not a list of rules.
  it("keeps the lasting sentence when a task list under another heading follows", () => {
    expect(
      standingRules("From now on, keep accessibility in mind.\n\nThe change:\n\n- Add a button"),
    ).toEqual(["From now on, keep accessibility in mind."]);
  });

  it("takes nothing from an ordinary request, even one that mentions the future", () => {
    expect(
      standingRules(
        "Add pagination to the items list.\n\n- limit defaults to 20\n- cursor is opaque\n\nWe may add filters in a future release.",
      ),
    ).toEqual([]);
  });
});

// Phrase matching found 4 of 18 held-out prompts that stated lasting rules.
describe("rules read by a model", () => {
  const prompt =
    "Add a CSV export. House style: timestamps are always UTC ISO 8601, in every export we ship.";

  it("keeps a rule only when its quote appears in the prompt", async () => {
    const rules = await statedRules([prompt], async () => [
      {
        rule: "Timestamps are UTC ISO 8601 in every export.",
        quote: "timestamps are  always UTC ISO 8601",
      },
      { rule: "Exports are gzip-compressed.", quote: "exports are gzip-compressed" },
      { rule: "CSV only.", quote: "CSV" },
    ]);
    expect(rules).toEqual(["Timestamps are UTC ISO 8601 in every export."]);
  });

  // Review: "use tabs" then "scratch that, use spaces" must not record both.
  it("reads all prompts in one call so a later message can replace a rule", async () => {
    const calls: (readonly string[])[] = [];
    const rules = await statedRules(
      ["From now on, use tabs.", "Scratch that: from now on use four spaces."],
      async (prompts) => {
        calls.push(prompts);
        return [{ rule: "Use four spaces.", quote: "from now on use four spaces" }];
      },
    );
    expect(calls).toEqual([
      ["From now on, use tabs.", "Scratch that: from now on use four spaces."],
    ]);
    expect(rules).toEqual(["Use four spaces."]);
  });

  it("falls back to phrase matching when the model fails", async () => {
    const failing = async () => {
      throw new Error("offline");
    };
    expect(await statedRules(["From now on, never log request bodies."], failing)).toEqual([
      "From now on, never log request bodies.",
    ]);
  });
});

describe("project rules", () => {
  const at = "2026-09-27T00:00:00.000Z";

  it("uses content identities and ignores restated rules", () => {
    const first = mergeProjectRules([], ["Money is integer cents."], "001-a", at);
    const second = mergeProjectRules(
      first.rules,
      ["money is  integer cents.", "Never hard-delete."],
      "002-b",
      at,
    );
    expect(second.added.map((rule) => [rule.id, rule.text])).toEqual([
      [expect.stringMatching(/^R-[a-f0-9]{16}$/), "Never hard-delete."],
    ]);
    expect(new Set(second.rules.map((rule) => rule.id)).size).toBe(2);
  });

  it("renders rules as plain numbered lines that say where they came from", () => {
    const { rules } = mergeProjectRules([], ["Money is integer cents."], "001-a", at);
    expect(projectRulesText(rules)).toBe(
      `Project rules the user stated for all later work on this project (they apply here too; only where a specific statement in the current request conflicts with a project rule for the same case does that statement take precedence, and only for the conflicting requirement; all compatible rules and rules about cases the request does not address still apply):\n${rules[0]?.id} Money is integer cents.`,
    );
    expect(projectRulesText([])).toBe("");
  });
});
