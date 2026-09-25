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
});
