import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { productBehaviorProbes } from "../../../../src/workflow/product/behavior-probes.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";

const fixture = new URL("../../../fixtures/product-quality/feather-fury/", import.meta.url);
it("preserves five real integration defects alongside the improved physics counterchecks", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("counterchecks.cjs", fixture))],
    { timeout: 10000 },
  );
  const results = JSON.parse(stdout) as {
    name: string;
    issueReproduced?: boolean;
    passed?: boolean;
    second?: { vx: number; vy: number };
    livingPigs?: number;
  }[];
  expect(results.filter((entry) => entry.issueReproduced)).toHaveLength(5);
  expect(results.filter((entry) => entry.passed)).toHaveLength(2);
  expect(results.find((entry) => entry.second)?.second).toEqual({ vx: 0, vy: 0 });
  expect(results.find((entry) => entry.livingPigs)?.livingPigs).toBe(2);
});
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
