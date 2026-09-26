import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { needsBrowser } from "../../../../src/workflow/product/environment.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import { productReviewAgenda } from "../../../../src/workflow/product/review-context.js";

const fixture = new URL("../../../fixtures/product-quality/orbital-flock/", import.meta.url);
it("uses the real brief to schedule early browser capability and critique primary UI usability", async () => {
  const brief = productBriefSchema.parse(
    parse(await readFile(new URL("brief.yaml", fixture), "utf8")),
  );
  const record = {
    brief,
    state: initialProductState(brief, "2026-09-08T00:00:00Z"),
    briefText: "",
    stateText: "",
  };
  const agenda = productReviewAgenda(record);
  expect(agenda.design?.description).toContain("canvas");
  expect(agenda.visualPrompts.map((entry) => entry.prompt).join("\n")).toContain("usable area");
  const slice = brief.slices[0];
  if (!slice) throw new Error("Missing retained slice");
  expect(needsBrowser({ ...brief, checks: [] }, { ...slice, checks: [] })).toBe(true);
});
