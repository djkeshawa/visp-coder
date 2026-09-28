import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeBuildId } from "../../../src/build/build-id.js";

describe("computeBuildId", () => {
  it("is stable for identical runtime inputs and changes with source", async () => {
    const root = await mkdtemp(join(tmpdir(), "visp-build-id-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/index.ts"), "export const value = 1;\n");
      await writeFile(join(root, "package.json"), '{"version":"1.0.0"}\n');
      await writeFile(join(root, "tsup.config.ts"), "export default {};\n");

      const first = computeBuildId(root);
      expect(computeBuildId(root)).toBe(first);

      await writeFile(join(root, "src/index.ts"), "export const value = 2;\n");
      expect(computeBuildId(root)).not.toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores editor debris and line endings while including new source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "visp-build-id-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src/index.ts"), "export const value = 1;\n");
      await writeFile(join(root, "package.json"), '{"version":"1.0.0"}\n');
      const first = computeBuildId(root);
      await writeFile(join(root, "src/index.ts"), "export const value = 1;\r\n");
      await writeFile(join(root, "src/.DS_Store"), "machine-specific");
      await writeFile(join(root, "src/index.ts~"), "editor backup");
      expect(computeBuildId(root)).toBe(first);
      await writeFile(join(root, "src/new.ts"), "export const newValue = 2;\n");
      expect(computeBuildId(root)).not.toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
