import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkRepository, worktreeFingerprint } from "../../../../src/graph/walker/index.js";
import { type Fixture, graphConfig, makeRepo } from "../fixtures.js";

let repo: Fixture;
const externalRoots: string[] = [];

beforeEach(async () => {
  repo = await makeRepo({
    "src/a.ts": "export const a = 1;\n",
    "src/b.py": "value = 1\n",
    "docs/notes.md": "# notes\n",
    ".gitignore": "ignored/\n*.log\n",
    "ignored/secret.ts": "export const secret = 1;\n",
    "debug.log": "noise\n",
    "node_modules/pkg/index.js": "module.exports = {};\n",
  });
});

afterEach(async () => {
  await repo.cleanup();
  await Promise.all(
    externalRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function walk(config = graphConfig()) {
  const result = await walkRepository(repo.root, config);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("walkRepository", () => {
  it("records supported files with a language, size and hash", async () => {
    const { files } = await walk();
    const a = files.find((file) => file.path === "src/a.ts");

    expect(a).toBeDefined();
    expect(a?.language).toBe("typescript");
    expect(a?.bytes).toBeGreaterThan(0);
    expect(a?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("honors .gitignore for directories and patterns", async () => {
    const { files, skipped } = await walk();

    expect(files.map((file) => file.path)).not.toContain("ignored/secret.ts");
    expect(files.map((file) => file.path)).not.toContain("debug.log");
    expect(skipped).toContainEqual({ path: "ignored", reason: "gitignored" });
    expect(skipped).toContainEqual({ path: "debug.log", reason: "gitignored" });
  });

  it("does not follow a root .gitignore symlink", async () => {
    await repo.remove(".gitignore");
    await repo.write("ignore-rules", "src/a.ts\n");
    await symlink("ignore-rules", join(repo.root, ".gitignore"));

    const { files, skipped } = await walk();

    expect(files.map((file) => file.path)).toContain("src/a.ts");
    expect(skipped).toContainEqual({ path: ".gitignore", reason: "symlink" });
  });

  it("does not follow a nested .gitignore symlink", async () => {
    await repo.write("src/ignore-rules", "a.ts\n");
    await symlink("ignore-rules", join(repo.root, "src/.gitignore"));

    const { files, skipped } = await walk();

    expect(files.map((file) => file.path)).toContain("src/a.ts");
    expect(skipped).toContainEqual({ path: "src/.gitignore", reason: "symlink" });
  });

  it("does not follow a chained .gitignore symlink", async () => {
    await repo.remove(".gitignore");
    await repo.write("ignore-rules", "src/a.ts\n");
    await symlink("ignore-link", join(repo.root, ".gitignore"));
    await symlink("ignore-rules", join(repo.root, "ignore-link"));

    const { files, skipped } = await walk();

    expect(files.map((file) => file.path)).toContain("src/a.ts");
    expect(skipped).toContainEqual({ path: ".gitignore", reason: "symlink" });
    expect(skipped).toContainEqual({ path: "ignore-link", reason: "symlink" });
  });

  it("ignores a dangling .gitignore symlink", async () => {
    await repo.remove(".gitignore");
    await symlink("missing-ignore", join(repo.root, ".gitignore"));

    const { files, skipped } = await walk();

    expect(files.map((file) => file.path)).toContain("src/a.ts");
    expect(skipped).toContainEqual({ path: ".gitignore", reason: "symlink" });
  });

  it("never applies ignore rules from an external .gitignore symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "visp-ignore-outside-"));
    externalRoots.push(outside);
    const externalIgnore = join(outside, "external-ignore");
    await writeFile(externalIgnore, "src/a.ts\n", "utf8");
    await repo.remove(".gitignore");
    await symlink(externalIgnore, join(repo.root, ".gitignore"));

    const { files, skipped } = await walk();

    expect(files.map((file) => file.path)).toContain("src/a.ts");
    expect(skipped).toContainEqual({ path: ".gitignore", reason: "symlink" });
    await expect(readFile(externalIgnore, "utf8")).resolves.toBe("src/a.ts\n");
  });

  it("never enters hard-ignored directories", async () => {
    const { files, skipped } = await walk();
    const paths = [...files.map((file) => file.path), ...skipped.map((entry) => entry.path)];
    expect(paths.some((path) => path.startsWith("node_modules"))).toBe(false);
  });

  it("skips symlinks and records them", async () => {
    await symlink(join(repo.root, "src/a.ts"), join(repo.root, "src/link.ts"));
    const { files, skipped } = await walk();

    expect(files.map((file) => file.path)).not.toContain("src/link.ts");
    expect(skipped).toContainEqual({ path: "src/link.ts", reason: "symlink" });
  });

  it("skips a file over the byte ceiling and says so", async () => {
    await writeFile(join(repo.root, "src/big.ts"), "x".repeat(4096), "utf8");
    const { files, skipped } = await walk(graphConfig({ maxFileBytes: 1024 }));

    expect(files.map((file) => file.path)).not.toContain("src/big.ts");
    expect(skipped).toContainEqual({ path: "src/big.ts", reason: "too_large" });
  });

  it("skips binary files", async () => {
    await writeFile(join(repo.root, "src/blob.bin"), Buffer.from([1, 2, 0, 3]));
    const { skipped } = await walk();
    expect(skipped).toContainEqual({ path: "src/blob.bin", reason: "binary" });
  });

  it("applies configured exclude globs", async () => {
    const { files, skipped } = await walk(graphConfig({ exclude: ["docs/**"] }));
    expect(files.map((file) => file.path)).not.toContain("docs/notes.md");
    expect(skipped.some((entry) => entry.reason === "excluded")).toBe(true);
  });

  it("returns a deterministic order across runs", async () => {
    const first = await walk();
    const second = await walk();
    expect(first.files.map((file) => file.path)).toEqual(second.files.map((file) => file.path));
    expect([...first.files.map((file) => file.path)].sort()).toEqual(
      first.files.map((file) => file.path),
    );
  });
});

describe("worktreeFingerprint", () => {
  it("is stable regardless of input order", async () => {
    const { files } = await walk();
    const reversed = [...files].reverse();
    expect(worktreeFingerprint(files)).toBe(worktreeFingerprint(reversed));
  });

  it("changes when a file's content changes", async () => {
    const before = worktreeFingerprint((await walk()).files);
    await repo.write("src/a.ts", "export const a = 2;\n");
    expect(worktreeFingerprint((await walk()).files)).not.toBe(before);
  });
});
