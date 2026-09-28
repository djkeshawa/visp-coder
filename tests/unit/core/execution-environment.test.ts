import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  productExecutionEnvironment,
  productIdentityEnvironment,
  resolvedProductExecutionEnvironment,
} from "../../../src/core/execution-environment.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([
  "TERM",
  "COLUMNS",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
  "UNRELATED_SETTING",
])("excludes incidental %s from product identity while passing it to checks", (name) => {
  vi.stubEnv(name, "first");
  const before = productIdentityEnvironment();
  vi.stubEnv(name, "second");
  expect(productIdentityEnvironment()).toEqual(before);
  expect(productExecutionEnvironment()[name]).toBe("second");
});

it.each(["PATH", "NODE_OPTIONS", "PYTHONPATH", "LANG", "LC_ALL", "TZ", "CI"])(
  "includes behavior-affecting %s in product identity",
  (name) => {
    vi.stubEnv(name, "first");
    const before = productIdentityEnvironment();
    vi.stubEnv(name, "second");
    expect(productIdentityEnvironment()).not.toEqual(before);
  },
);

it("includes explicitly declared application variables", () => {
  vi.stubEnv("APP_MODE", "first");
  const before = productIdentityEnvironment(["APP_MODE"]);
  vi.stubEnv("APP_MODE", "second");
  expect(productIdentityEnvironment(["APP_MODE"])).not.toEqual(before);
});

async function isolatedCache() {
  const root = await mkdtemp(join(tmpdir(), "visp-cache-test-"));
  roots.push(root);
  vi.stubEnv("TMPDIR", root);
  vi.stubEnv("PYTHONPYCACHEPREFIX", undefined);
  return root;
}

it("redirects Python bytecode into a private, user-owned directory", async () => {
  const root = await isolatedCache();
  const prefix = (await resolvedProductExecutionEnvironment()).PYTHONPYCACHEPREFIX;
  expect(prefix?.startsWith(root)).toBe(true);
  const info = await lstat(prefix ?? "");
  expect(info.isDirectory()).toBe(true);
  expect(info.mode & 0o777).toBe(0o700);
  expect(info.uid).toBe(process.getuid?.());
});

it("refuses a cache made writable by other users", async () => {
  await isolatedCache();
  const prefix = (await resolvedProductExecutionEnvironment()).PYTHONPYCACHEPREFIX;
  await chmod(prefix ?? "", 0o777);
  await expect(resolvedProductExecutionEnvironment()).rejects.toThrow("Unsafe Python cache");
});

it("refuses a precreated cache symlink", async () => {
  const root = await isolatedCache();
  const target = join(root, "attacker");
  await mkdir(target);
  await symlink(target, join(root, `visp-python-cache-${process.getuid?.()}`));
  await expect(resolvedProductExecutionEnvironment()).rejects.toThrow("Unsafe Python cache");
});

it("keeps an operator's explicit Python cache location", async () => {
  vi.stubEnv("PYTHONPYCACHEPREFIX", "/operator/cache");
  expect((await resolvedProductExecutionEnvironment()).PYTHONPYCACHEPREFIX).toBe("/operator/cache");
});
