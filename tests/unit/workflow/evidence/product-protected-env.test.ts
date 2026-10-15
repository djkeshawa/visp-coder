import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import {
  changedProtectedEnvFiles,
  protectedEnvSnapshot,
} from "../../../../src/workflow/product/protected-env.js";

/**
 * Environment files are usually git-ignored, so Git's diff never shows an agent editing
 * them. The snapshot finds them wherever they are, ignored directories included, except in
 * the few directories that hold dependencies, builds or VISP's own state.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-protected-env-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

it("hashes every environment file outside dependency, build and state directories", async () => {
  await write(".env", "ROOT=1");
  await write("api/.env.local", "API=1");
  await write(".venv/lib/.ENV.production", "VENV=1");
  await write("config/.env/.env.test", "IN_A_DIRECTORY_NAMED_ENV=1");
  await write("config/.env/notes.txt", "not an environment file");
  for (const skipped of ["node_modules", "NODE_MODULES", "dist", "build", ".visp", ".git"])
    await write(`${skipped}/.env`, "SKIPPED=1");
  await write("src/environment.ts", "export {};");
  await symlink("../.env", join(root, "api", ".env.shared"));

  const snapshot = await protectedEnvSnapshot(root);

  expect(snapshot).toEqual({
    ok: true,
    value: {
      ".env": sha256("ROOT=1"),
      "api/.env.local": sha256("API=1"),
      "api/.env.shared": "link:../.env",
      ".venv/lib/.ENV.production": sha256("VENV=1"),
      "config/.env/.env.test": sha256("IN_A_DIRECTORY_NAMED_ENV=1"),
    },
  });
  // Stable order, so a recorded baseline does not churn between identical snapshots.
  expect(Object.keys(snapshot.ok ? snapshot.value : {})).toEqual([
    ".env",
    ".venv/lib/.ENV.production",
    "api/.env.local",
    "api/.env.shared",
    "config/.env/.env.test",
  ]);
});

it("reports added, changed and removed environment files", async () => {
  await write(".env", "A=1");
  await write("api/.env", "B=1");
  const baseline = await protectedEnvSnapshot(root);
  if (!baseline.ok) throw new Error(baseline.error.message);
  await write(".env", "A=2");
  await rm(join(root, "api/.env"));
  await write("web/.env.local", "C=1");

  const changed = await changedProtectedEnvFiles(root, baseline.value);

  expect(changed.ok && [...changed.value].sort()).toEqual([".env", "api/.env", "web/.env.local"]);
});
