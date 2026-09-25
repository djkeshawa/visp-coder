import { expect, it } from "vitest";
import { BRIEF_FIELDS_EXAMPLE, BRIEF_INPUT_HELP } from "../../../../src/harness/command-guide.js";
import { parseProductBrief } from "../../../../src/workflow/product/model.js";

const base = {
  version: 2,
  feature: "001-example",
  originalRequest: "Return a value",
  goal: "Return a value",
};

it("keeps the documented editable fragment compatible with the brief parser", () => {
  const input = { ...base, ...BRIEF_FIELDS_EXAMPLE };
  const before = JSON.stringify(input);
  const result = parseProductBrief(input);
  expect(result.ok).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
  expect(BRIEF_INPUT_HELP).toContain(JSON.stringify(BRIEF_FIELDS_EXAMPLE, null, 2));
});

it("reports precise brief paths without dumping repeated validation metadata", () => {
  const input = {
    ...base,
    outcomes: [{ kind: "functional", title: "Value" }],
    slices: [{ title: "Build", outcomeIds: ["O001"] }],
  };
  const before = JSON.stringify(input);
  const result = parseProductBrief(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Invalid brief accepted");
  expect(result.error.message).toContain("outcomes.0.statement: Required");
  expect(result.error.message).toContain("slices.0.goal: Required");
  expect(result.error.message).toContain("slices.0.scope: Required");
  expect(result.error.message).toContain("outcomeIds");
  expect(result.error.message).not.toContain('"code":');
  expect(result.error.recovery).toContain("visp brief --help");
  expect(JSON.stringify(input)).toBe(before);
});

it("keeps semantic reference failures distinct and rejects unknown fields without guessing aliases", () => {
  const result = parseProductBrief({
    ...base,
    outcomes: [{ id: "O001", kind: "functional", statement: "Two" }],
    slices: [{ goal: "Return value", scope: { allowed: ["value.js"] }, outcomes: ["O999"] }],
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Unknown outcome accepted");
  expect(result.error.message).toContain("O999");
  expect(parseProductBrief({ ...base, status: "accepted" }).ok).toBe(false);
});
