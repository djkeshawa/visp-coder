import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const fixture = new URL("../../../fixtures/product-quality/crater-critters/", import.meta.url);
it("exposes inert structures and remote-hit credit while the run's own smoke checks pass", async () => {
  const run = (name: string) =>
    promisify(execFile)(process.execPath, [fileURLToPath(new URL(name, fixture))], {
      timeout: 10000,
    });
  await expect(run("smoke.mjs")).resolves.toBeDefined();
  const results = JSON.parse((await run("counterchecks.cjs")).stdout);
  expect(results).toEqual([
    { check: "clear miss must not score", defect: true, centerDistance: 128, combinedRadii: 47 },
    { check: "actual contact must score", passed: true },
    { check: "overlapping block must receive damage", defect: true },
  ]);
});
