import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const fixture = new URL("../../../fixtures/product-quality/feather-fling/", import.meta.url);
it("reproduces broken trajectory, impulse, retry, cancellation and support behavior despite passing smoke checks", async () => {
  const run = (name: string) =>
    promisify(execFile)(process.execPath, [fileURLToPath(new URL(name, fixture))], {
      timeout: 10000,
    });
  expect((await run("tests/smoke.mjs")).stdout).toContain("smoke checks passed");
  const results = JSON.parse((await run("counterchecks.cjs")).stdout) as {
    defect?: boolean;
    passed?: boolean;
    actual?: { vx?: number };
  }[];
  expect(results.filter((entry) => entry.defect)).toHaveLength(5);
  expect(results.filter((entry) => entry.passed)).toHaveLength(1);
  expect(results[1]?.actual?.vx).toBe(22.5);
});
