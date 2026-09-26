import { describe, expect, it } from "vitest";
import {
  mergeProjectRules,
  projectRulesText,
  standingRules,
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

  it("takes nothing from an ordinary request, even one that mentions the future", () => {
    expect(
      standingRules(
        "Add pagination to the items list.\n\n- limit defaults to 20\n- cursor is opaque\n\nWe may add filters in a future release.",
      ),
    ).toEqual([]);
  });
});

describe("project rules", () => {
  const at = "2026-09-27T00:00:00.000Z";

  it("numbers new rules after existing ones and ignores restated ones", () => {
    const first = mergeProjectRules([], ["Money is integer cents."], "001-a", at);
    const second = mergeProjectRules(
      first.rules,
      ["money is  integer cents.", "Never hard-delete."],
      "002-b",
      at,
    );
    expect(second.added.map((rule) => [rule.id, rule.text])).toEqual([
      ["R002", "Never hard-delete."],
    ]);
    expect(second.rules.map((rule) => rule.id)).toEqual(["R001", "R002"]);
  });

  it("renders rules as plain numbered lines that say where they came from", () => {
    const { rules } = mergeProjectRules([], ["Money is integer cents."], "001-a", at);
    expect(projectRulesText(rules)).toBe(
      "Project rules the user stated for all later work on this project (they apply here too):\nR001 Money is integer cents.",
    );
    expect(projectRulesText([])).toBe("");
  });
});
