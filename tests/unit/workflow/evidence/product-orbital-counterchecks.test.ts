import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { needsBrowser } from "../../../../src/workflow/product/environment.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import { productReviewAgenda } from "../../../../src/workflow/product/review-context.js";

const fixture = new URL("../../../fixtures/product-quality/orbital-flock/", import.meta.url);
it("executes independent collision and reset counterchecks on the frozen game", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("orbital-flock-counterchecks.cjs", fixture))],
    { timeout: 10000 },
  );
  const result = JSON.parse(stdout);
  expect(
    result.topContacts.every(
      (entry: { collision: { nx: number; ny: number } }) =>
        entry.collision.nx === 0 && entry.collision.ny === -1,
    ),
  ).toBe(true);
  expect(result.cornerReflection.observed.vy).not.toBeCloseTo(
    result.cornerReflection.expectedWithExistingDamping.vy,
  );
  expect(result.resetRace).toMatchObject({ turn: "ready", overlayVisible: true, targetsAlive: 3 });
  expect(result.playAgain.levelIndex).toBe(2);
  expect(
    result.quickShotLevels
      .filter((entry: { level: number }) => entry.level === 1)
      .every((entry: { turn: string }) => entry.turn === "won"),
  ).toBe(true);
});
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
