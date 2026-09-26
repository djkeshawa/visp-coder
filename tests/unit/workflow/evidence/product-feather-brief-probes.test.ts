import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { productBehaviorProbes } from "../../../../src/workflow/product/behavior-probes.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";

const fixture = new URL("../../../fixtures/product-quality/feather-fury/", import.meta.url);
it("delivers targeted counterexamples for the real accepted brief rather than another broad checklist", async () => {
  const brief = productBriefSchema.parse(
    parse(await readFile(new URL("brief.yaml", fixture), "utf8")),
  );
  const record = {
    brief,
    state: initialProductState(brief, "2026-09-09"),
    briefText: "",
    stateText: "",
  };
  const probes = productBehaviorProbes(record).probes;
  expect(probes).toHaveLength(3);
  expect(probes.find((entry) => entry.kind === "repeat-and-recover")?.question).toContain(
    "old work must not change the new state",
  );
  expect(probes.find((entry) => entry.kind === "repeat-and-recover")?.question).toContain(
    "wait beyond the old completion",
  );
  expect(probes.find((entry) => entry.kind === "rendered-usability")?.question).toContain(
    "canvas proportions",
  );
});
