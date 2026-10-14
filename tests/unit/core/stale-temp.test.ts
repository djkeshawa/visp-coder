import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  markOwner,
  removeTreeBestEffort,
  sweepAbandonedCredentialHomes,
  sweepStaleTempDirectories,
} from "../../../src/core/stale-temp.js";

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

/**
 * A SIGKILLed reviewer or tester leaves its private copy of the Codex sign-in on disk, which
 * the age-based sweep removed only after an hour. The copy names the process that made it, so
 * any later launch (or doctor) removes it as soon as that process is gone.
 */
it("removes a sign-in copy whose owner process has ended, at any age", async () => {
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
    encoding: "utf8",
  });
  const deadPid = Number(dead.stdout.trim());
  const abandoned = await withAuth("visp-tester-aBc123", 0);
  const live = await withAuth("visp-critic-dEf456", 0);
  const unmarked = await withAuth("visp-critic-gHi789", 0);
  await markOwner(join(abandoned, "codex-home"), deadPid);
  await markOwner(join(live, "codex-home"));

  await sweepAbandonedCredentialHomes(dir);

  expect(existsSync(join(abandoned, "codex-home"))).toBe(false);
  // Only the credential home goes; the run directory is left to the age-based sweep.
  expect(existsSync(abandoned)).toBe(true);
  expect(existsSync(join(live, "codex-home", "auth.json"))).toBe(true);
  expect(existsSync(join(unmarked, "codex-home", "auth.json"))).toBe(true);
});

// A PID means nothing across PID namespaces or hosts (a shared /tmp in a container or over
// NFS): the owner may be alive there, so its copy is kept, as the state lock does.
it("keeps a sign-in copy whose owner is in another PID namespace or on another host", async () => {
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
    encoding: "utf8",
  });
  const deadPid = Number(dead.stdout.trim());
  const namespaced = await withAuth("visp-tester-nSp123", 0);
  const remote = await withAuth("visp-tester-hSt456", 0);
  await markOwner(join(namespaced, "codex-home"), deadPid);
  await markOwner(join(remote, "codex-home"), deadPid);
  const marker = (path: string) => join(path, "codex-home", ".visp-owner.json");
  const rewrite = async (path: string, change: Record<string, unknown>) =>
    writeFile(
      marker(path),
      JSON.stringify({ ...JSON.parse(await readFile(marker(path), "utf8")), ...change }),
    );
  await rewrite(namespaced, { pidNamespace: "pid:[4026599999]" });
  await rewrite(remote, { host: "another-host.example" });

  await sweepAbandonedCredentialHomes(dir);

  expect(existsSync(join(namespaced, "codex-home", "auth.json"))).toBe(true);
  expect(existsSync(join(remote, "codex-home", "auth.json"))).toBe(true);
});
