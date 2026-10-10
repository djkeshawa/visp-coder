import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectPreset } from "../../../src/config/detect.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "visp-detect-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function writePackageJson(manifest: unknown): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
}

describe("detectPreset", () => {
  it("uses tracked Python sources over a root JavaScript tooling manifest", async () => {
    await writePackageJson({ scripts: { test: "eslint" } });
    await writeFile(join(dir, "app.py"), "");
    await writeFile(join(dir, "models.py"), "");
    await writeFile(join(dir, "lint.js"), "");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    for (let index = 0; index < 5; index++) await writeFile(join(dir, `untracked${index}.js`), "");
    expect(await detectPreset(dir)).toBe("python");
  });

  it("counts the full tracked inventory beyond the diagnostic output cap", async () => {
    await writePackageJson({ devDependencies: { typescript: "5" } });
    await writeFile(join(dir, "pyproject.toml"), "");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: "",
      encoding: "utf8",
    }).trim();
    const records: string[] = [];
    for (const [prefix, count, extension] of [
      ["a", 20_000, "ts"],
      ["m", 60_000, "py"],
      ["z", 20_000, "ts"],
    ] as const) {
      for (let index = 0; index < count; index++) {
        records.push(`100644 ${blob}\t${prefix}/${"x".repeat(150)}${index}.${extension}\0`);
      }
    }
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd: dir,
      input: records.join(""),
    });
    const inventory = execFileSync("git", ["ls-files", "-z"], {
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(inventory.length).toBeGreaterThan(8 * 1024 * 1024);
    expect(await detectPreset(dir)).toBe("python");
  });

  it.each([
    ["unterminated output", "process.stdout.write('one.ts\\0two.ts\\0partial')"],
    ["failed listing", "process.stdout.write('one.ts\\0two.ts\\0'); process.exitCode = 1"],
    [
      "expired deadline",
      "process.stdout.write('one.ts\\0two.ts\\0'); setTimeout(() => {}, 10_000)",
    ],
  ])("discards the tracked counts on %s and walks sources instead", async (_name, body) => {
    await writeFile(join(dir, "app.py"), "");
    await mkdir(join(dir, "tools"));
    const git = join(dir, "tools/git");
    await writeFile(git, `#!${process.execPath}\n${body}\n`);
    await chmod(git, 0o755);
    vi.stubEnv("PATH", `${join(dir, "tools")}:${process.env.PATH ?? ""}`);
    const started = Date.now();
    expect(await detectPreset(dir)).toBe("python");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it.each([false, true])(
    "excludes generated and fixture sources (tracked: %s)",
    async (tracked) => {
      await writePackageJson({});
      await writeFile(join(dir, "app.py"), "");
      for (const name of [
        "node_modules",
        "vendor",
        "dist",
        "build",
        "static",
        "third_party",
        "js_tests",
        "fixtures",
      ]) {
        await mkdir(join(dir, name));
        await writeFile(join(dir, name, "one.js"), "");
        await writeFile(join(dir, name, "two.js"), "");
      }
      await writeFile(join(dir, "bundle.min.js"), "");
      if (tracked) {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        execFileSync("git", ["add", "-f", "."], { cwd: dir });
      }
      expect(await detectPreset(dir)).toBe("python");
    },
  );

  it.each([
    ["app.ts", "typescript"],
    ["app.go", "go"],
    ["app.rs", "rust"],
  ] as const)("detects %s from source files", async (name, preset) => {
    await writeFile(join(dir, name), "");
    expect(await detectPreset(dir)).toBe(preset);
  });

  it("detects JavaScript sources without a manifest", async () => {
    await writeFile(join(dir, "app.js"), "");
    expect(await detectPreset(dir)).toBe("javascript");
  });

  it("lets markers break source-count ties and preserves framework presets", async () => {
    await writePackageJson({ dependencies: { react: "18" } });
    await writeFile(join(dir, "app.tsx"), "");
    await writeFile(join(dir, "app.py"), "");
    expect(await detectPreset(dir)).toBe("react");
  });

  it("breaks a tie using markers for the tied languages despite unrelated JS tooling", async () => {
    await writePackageJson({});
    await writeFile(join(dir, "pyproject.toml"), "");
    await writeFile(join(dir, "app.py"), "");
    await writeFile(join(dir, "app.go"), "");
    expect(await detectPreset(dir)).toBe("python");
  });

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
