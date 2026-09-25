import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPreset } from "../../../src/config/detect.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "visp-detect-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePackageJson(manifest: unknown): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
}

describe("detectPreset", () => {
  it("falls back to generic for an empty directory", async () => {
    expect(await detectPreset(dir)).toBe("generic");
  });

  it("prefers react over typescript when react is a dependency", async () => {
    await writePackageJson({ dependencies: { react: "18", typescript: "5" } });
    expect(await detectPreset(dir)).toBe("react");
  });

  it("detects a node api from its server framework", async () => {
    await writePackageJson({ dependencies: { express: "4" } });
    expect(await detectPreset(dir)).toBe("node-api");
  });

  it("detects typescript from a devDependency", async () => {
    await writePackageJson({ devDependencies: { typescript: "5" } });
    expect(await detectPreset(dir)).toBe("typescript");
  });

  it("detects typescript from tsconfig.json alongside package.json", async () => {
    await writePackageJson({});
    await writeFile(join(dir, "tsconfig.json"), "{}");
    expect(await detectPreset(dir)).toBe("typescript");
  });

  it("treats a package.json without typescript as javascript", async () => {
    await writePackageJson({ dependencies: { lodash: "4" } });
    expect(await detectPreset(dir)).toBe("javascript");
  });

  it("detects python, go, and rust from their manifests", async () => {
    await writeFile(join(dir, "pyproject.toml"), "");
    expect(await detectPreset(dir)).toBe("python");

    await rm(join(dir, "pyproject.toml"));
    await writeFile(join(dir, "go.mod"), "");
    expect(await detectPreset(dir)).toBe("go");

    await rm(join(dir, "go.mod"));
    await writeFile(join(dir, "Cargo.toml"), "");
    expect(await detectPreset(dir)).toBe("rust");
  });

  it("ignores a malformed package.json instead of failing", async () => {
    await writeFile(join(dir, "package.json"), "{ broken");
    await writeFile(join(dir, "go.mod"), "");
    expect(await detectPreset(dir)).toBe("go");
  });
});
