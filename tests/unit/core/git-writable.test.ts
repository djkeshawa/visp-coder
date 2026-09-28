import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitWritable } from "../../../src/core/git.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    execFileSync("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visp-git-writable-"));
  roots.push(root);
  return root;
}

async function repository(): Promise<string> {
  const root = await directory();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
}

// chmod cannot make a directory read-only for root, and Windows has no POSIX modes.
const cannotRestrict = process.getuid?.() === 0 || process.platform === "win32";

describe("gitWritable", () => {
  it("is true for a writable repository and leaves no probe file behind", async () => {
    const root = await repository();
    expect(await gitWritable(root)).toBe(true);
    expect((await readdir(join(root, ".git"))).filter((name) => name.includes("probe"))).toEqual(
      [],
    );
  });

  it.skipIf(cannotRestrict)("is false when .git is read-only, as in Codex's sandbox", async () => {
    const root = await repository();
    execFileSync("chmod", ["-R", "a-w", join(root, ".git")]);
    expect(await gitWritable(root)).toBe(false);
    expect((await readdir(join(root, ".git"))).filter((name) => name.includes("probe"))).toEqual(
      [],
    );
  });

  it("counts an unknown answer as writable, so the commit rule is never waived", async () => {
    expect(await gitWritable(await directory())).toBe(true);
  });
});
