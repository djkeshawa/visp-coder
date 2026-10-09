import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ALL_FEATURES, featureOf, watchState } from "../../../src/ui/watcher.js";

it("maps a changed state file to the feature it belongs to", () => {
  expect(featureOf("features/002-export/product-state.json")).toBe("002-export");
  expect(featureOf("features\\002-export\\brief.yaml")).toBe("002-export");
  expect(featureOf("status.json")).toBe(ALL_FEATURES);
  expect(featureOf("features")).toBe(ALL_FEATURES);
  expect(featureOf(null)).toBe(ALL_FEATURES);
});

it("reports a batch of writes to one feature as one change", async () => {
  const state = await mkdtemp(join(tmpdir(), "visp-ui-state-"));
  await mkdir(join(state, "features", "001-a"), { recursive: true });
  const changes: (readonly string[])[] = [];
  const watcher = watchState(state, (features) => changes.push(features));
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(join(state, "features", "001-a", "product-state.json"), "{}");
    await writeFile(join(state, "features", "001-a", "brief.yaml"), "goal: a");
    await expect.poll(() => changes.length, { timeout: 3_000 }).toBeGreaterThan(0);
    expect(changes[0]).toContain("001-a");
  } finally {
    watcher.close();
    await rm(state, { recursive: true, force: true });
  }
});
