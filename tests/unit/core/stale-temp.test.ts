import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeTreeBestEffort, sweepStaleTempDirectories } from "../../../src/core/stale-temp.js";

const HOUR = 60 * 60_000;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "visp-stale-temp-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function age(path: string, hours: number) {
  const then = new Date(Date.now() - hours * HOUR);
  await utimes(path, then, then);
}

async function withAuth(name: string, hours: number) {
  const path = join(dir, name);
  await mkdir(join(path, "codex-home"), { recursive: true });
  await writeFile(join(path, "codex-home", "auth.json"), "{}");
  await age(path, hours);
  return path;
}

it("removes old directories with a listed prefix and keeps fresh ones", async () => {
  const old = await withAuth("visp-critic-aBc123", 2);
  const fresh = await withAuth("visp-review-bDe456", 0.1);
  await sweepStaleTempDirectories([/^visp-(?:critic|review)-[A-Za-z0-9]{6}$/], HOUR, dir);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

it("leaves named directories that only share a prefix alone", async () => {
  const calibration = await withAuth("visp-review-calibration-inputs", 5);
  const home = await withAuth("visp-critic-home-x", 5);
  await sweepStaleTempDirectories([/^visp-(?:critic|review)-[A-Za-z0-9]{6}$/], HOUR, dir);
  expect(existsSync(calibration)).toBe(true);
  expect(existsSync(home)).toBe(true);
});

it("leaves other names and plain files alone", async () => {
  const other = await withAuth("visp-reviewer-test", 5);
  const lookalike = await withAuth("xvisp-critic-aBc123", 5);
  const file = join(dir, "visp-critic-fILe12");
  await writeFile(file, "x");
  await age(file, 5);
  await sweepStaleTempDirectories([/^visp-critic-[A-Za-z0-9]{6}$/], HOUR, dir);
  expect(existsSync(other)).toBe(true);
  expect(existsSync(lookalike)).toBe(true);
  expect(existsSync(file)).toBe(true);
});

it("never follows a symlink that carries a listed name", async () => {
  const target = await mkdtemp(join(tmpdir(), "visp-stale-target-"));
  try {
    await writeFile(join(target, "keep.txt"), "keep");
    await age(target, 5);
    const link = join(dir, "visp-critic-lNk123");
    await symlink(target, link, "dir");
    await sweepStaleTempDirectories([/^visp-critic-[A-Za-z0-9]{6}$/], HOUR, dir);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
    expect(existsSync(link)).toBe(true);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("keeps directories owned by another user", async () => {
  const old = await withAuth("visp-critic-aBc123", 2);
  const posix = process as unknown as { getuid: () => number };
  vi.spyOn(posix, "getuid").mockReturnValue(posix.getuid() + 1);
  await sweepStaleTempDirectories([/^visp-critic-[A-Za-z0-9]{6}$/], HOUR, dir);
  expect(existsSync(old)).toBe(true);
});

it("ignores a missing directory and an empty list of names", async () => {
  await expect(
    sweepStaleTempDirectories([/^visp-critic-[A-Za-z0-9]{6}$/], HOUR, join(dir, "absent")),
  ).resolves.toBeUndefined();
  const old = await withAuth("visp-critic-aBc123", 2);
  await sweepStaleTempDirectories([], HOUR, dir);
  expect(existsSync(old)).toBe(true);
});

async function readOnlyTree(root: string) {
  await mkdir(join(root, "home", "mod", "deep"), { recursive: true });
  await writeFile(join(root, "home", "mod", "deep", "file"), "x");
  await chmod(join(root, "home", "mod", "deep"), 0o500);
  await chmod(join(root, "home", "mod"), 0o500);
}

it("removes a tree that holds read-only directories", async () => {
  const root = join(dir, "run");
  await readOnlyTree(root);
  await removeTreeBestEffort(root);
  expect(existsSync(root)).toBe(false);
});

it("never throws for a missing or unremovable path", async () => {
  await expect(removeTreeBestEffort(join(dir, "absent"))).resolves.toBeUndefined();
  await expect(removeTreeBestEffort("/proc/1/nonexistent")).resolves.toBeUndefined();
});

it("sweeps an abandoned baseline home even when it holds read-only directories", async () => {
  const path = join(dir, "visp-baseline-aBc123");
  await readOnlyTree(path);
  await age(path, 3);
  await sweepStaleTempDirectories([/^visp-baseline-[A-Za-z0-9]{6}$/], HOUR, dir);
  expect(existsSync(path)).toBe(false);
});
