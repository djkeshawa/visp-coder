import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const calibration = join(root, "tests/fixtures/review-calibration");
const preview = join(root, "tests/fixtures/product-quality/catapult-preview-regression");
const fixtures = (await import(
  pathToFileURL(join(root, "scripts/review-calibration-fixtures.mjs")).href
)) as {
  CALIBRATION_SCENARIOS: string[];
  PRERENDERED_SCENARIOS: string[];
  calibrationSources(
    root: string,
    scenario: string,
    variant: string,
  ): Promise<Record<string, string>>;
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("review calibration fixtures", () => {
  it("keeps seven scenarios, each with a prompt and both oracles", () => {
    expect(fixtures.CALIBRATION_SCENARIOS).toHaveLength(7);
    for (const scenario of fixtures.CALIBRATION_SCENARIOS) {
      expect(existsSync(join(calibration, scenario, "prompt.md")), scenario).toBe(true);
      for (const variant of ["defective", "control"]) {
        const oracle = JSON.parse(
          readFileSync(join(calibration, scenario, `${variant}-oracle.json`), "utf8"),
        );
        expect(oracle.variant).toBe(variant);
      }
    }
  });

  it("gives every defective new oracle a compilable caughtIf and controls none", () => {
    for (const scenario of ["catapult-preview", "slingshot-preview", "catapult-finish"]) {
      const defective = JSON.parse(
        readFileSync(join(calibration, scenario, "defective-oracle.json"), "utf8"),
      );
      const control = JSON.parse(
        readFileSync(join(calibration, scenario, "control-oracle.json"), "utf8"),
      );
      expect(defective.caughtIf.length, scenario).toBeGreaterThan(0);
      for (const alternative of defective.caughtIf as string[][]) {
        expect(alternative.length).toBeGreaterThan(0);
        for (const pattern of alternative) expect(() => new RegExp(pattern, "i")).not.toThrow();
      }
      expect(control.caughtIf).toBeUndefined();
      expect(control.expectedDefects).toEqual([]);
    }
  });

  describe("caughtIf matching", () => {
    const oracle = (scenario: string) =>
      JSON.parse(readFileSync(join(calibration, scenario, "defective-oracle.json"), "utf8"))
        .caughtIf as string[][];
    const caught = (scenario: string, text: string) =>
      oracle(scenario).some((alternative) =>
        alternative.every((pattern) => new RegExp(pattern, "i").test(text)),
      );

    it("catches a preview that starts away from the launch and ignores look-alike words", () => {
      for (const scenario of ["catapult-preview", "slingshot-preview"]) {
        expect(
          caught(
            scenario,
            "The dotted preview starts at the pulled stone, but after release the stone flies from the sling.",
          ),
        ).toBe(true);
        expect(caught(scenario, "Restart button search claim about the aim of the flight.")).toBe(
          false,
        );
        expect(caught(scenario, "The dotted preview matches the released flight.")).toBe(false);
        expect(caught(scenario, "Restart shows a guide after the pull.")).toBe(false);
      }
    });

    it("ties sparseness to level content and needs a real fire-without-wood statement", () => {
      expect(caught("catapult-finish", "Level 3 is bare: two stone frames and nothing else.")).toBe(
        true,
      );
      expect(caught("catapult-finish", "Fire is useless because the wood is missing.")).toBe(true);
      expect(caught("catapult-finish", "Flat ground level with a plain HUD button.")).toBe(false);
      expect(caught("catapult-finish", "The sparse HUD label is small. Levels are fine.")).toBe(
        false,
      );
      expect(caught("catapult-finish", "Firefox may search for a wooden bench.")).toBe(false);
      // Control-style findings about a finished game must not count as the defect.
      expect(
        caught(
          "catapult-finish",
          "Level 1 is a textured wood, stone and metal tower with banners; the HUD is minimal and clean.",
        ),
      ).toBe(false);
      expect(
        caught(
          "catapult-finish",
          "The playfield looks polished, with plain but readable ammo buttons.",
        ),
      ).toBe(false);
      expect(caught("catapult-finish", "Levels are detailed and the fire button works.")).toBe(
        false,
      );
      expect(caught("catapult-finish", "Level 3 is sparse: two single-color frames.")).toBe(true);
    });
  });

  it("freezes images and recorded operations for the prerendered scenarios without variant labels", () => {
    for (const scenario of fixtures.PRERENDERED_SCENARIOS) {
      for (const variant of ["defective", "control"]) {
        const files = readdirSync(join(calibration, scenario)).filter(
          (name) => name.startsWith(`${variant}-`) && !name.endsWith("-oracle.json"),
        );
        expect(
          files.filter((name) => name.endsWith(".png")).length,
          scenario,
        ).toBeGreaterThanOrEqual(2);
        expect(files).toContain(`${variant}-execution.json`);
        const execution = readFileSync(
          join(calibration, scenario, `${variant}-execution.json`),
          "utf8",
        );
        expect(execution).not.toContain("observedScope");
        expect(execution).not.toMatch(/\b(defective|control)\b|cat-cat|game-vnt|game-v-|nb-game/);
      }
    }
  });

  it("keeps the frozen fixture set modest", () => {
    const size = (directory: string): number =>
      readdirSync(directory, { withFileTypes: true }).reduce(
        (total, entry) =>
          total +
          (entry.isDirectory()
            ? size(join(directory, entry.name))
            : statSync(join(directory, entry.name)).size),
        0,
      );
    expect(size(calibration) + size(preview)).toBeLessThan(4 * 1024 * 1024);
  });

  it("records the frozen catapult source hashes", () => {
    const provenance = JSON.parse(readFileSync(join(preview, "provenance.json"), "utf8"));
    for (const [file, digest] of Object.entries(provenance.files as Record<string, string>))
      expect(sha(readFileSync(join(preview, file)))).toBe(digest);
  });

  it("repairs only the preview origin in the catapult control", async () => {
    const defective = await fixtures.calibrationSources(root, "catapult-preview", "defective");
    const control = await fixtures.calibrationSources(root, "catapult-preview", "control");
    expect(Object.keys(control)).toEqual(Object.keys(defective));
    expect(control["index.html"]).toBe(defective["index.html"]);
    expect(control["styles.css"]).toBe(defective["styles.css"]);
    const before = (defective["game.js"] as string).split("\n");
    const after = (control["game.js"] as string).split("\n");
    expect(after).toHaveLength(before.length);
    const changed = before.flatMap((line, index) => (line === after[index] ? [] : [index]));
    expect(changed).toHaveLength(2);
    expect(after[changed[0] as number]).toContain("SLING_X + vx * t");
    expect(after[changed[1] as number]).toContain("SLING_Y + vy * t");
  });
});
