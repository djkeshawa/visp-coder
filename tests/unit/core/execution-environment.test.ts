import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  comparisonEnvironmentParts,
  declaredEnvironment,
  productExecutionEnvironment,
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
  "PATH",
])("keeps incidental %s out of comparison components while passing it to checks", (name) => {
  vi.stubEnv(name, "first");
  const before = comparisonEnvironmentParts(productExecutionEnvironment());
  vi.stubEnv(name, "second");
  expect(comparisonEnvironmentParts(productExecutionEnvironment())).toEqual(before);
  expect(productExecutionEnvironment()[name]).toBe("second");
});

it.each([
  "NODE_OPTIONS",
  "PYTHONPATH",
  "DYLD_INSERT_LIBRARIES",
  "LD_PRELOAD",
  "LD_AUDIT",
  "BASH_ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PYTEST_ADDOPTS",
  "PYTEST_PLUGINS",
  "npm_config_registry",
  "NPM_CONFIG_PREFIX",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5LIB",
  "PERL5OPT",
  "GOFLAGS",
  "PLAYWRIGHT_BROWSERS_PATH",
  "LANG",
  "LC_ALL",
  "LC_TIME",
  "TZ",
  "CI",
])("includes behavior-affecting %s in comparison components", (name) => {
  vi.stubEnv(name, "first");
  const before = comparisonEnvironmentParts(productExecutionEnvironment());
  vi.stubEnv(name, "second");
  expect(comparisonEnvironmentParts(productExecutionEnvironment())).not.toEqual(before);
});

it("leaves the bytecode prefix VISP sets itself out of the comparison, but not an operator's", () => {
  vi.stubEnv("PYTHONPYCACHEPREFIX", "/visp/own-cache");
  const own = comparisonEnvironmentParts(productExecutionEnvironment(), "/visp/own-cache");
  vi.stubEnv("PYTHONPYCACHEPREFIX", "/operator/cache");
  const operator = comparisonEnvironmentParts(productExecutionEnvironment(), "/visp/own-cache");
  expect(operator).not.toEqual(own);
  vi.stubEnv("PYTHONPYCACHEPREFIX", "/operator/other");
  expect(comparisonEnvironmentParts(productExecutionEnvironment(), "/visp/own-cache")).not.toEqual(
    operator,
  );
  vi.stubEnv("PYTHONPYCACHEPREFIX", undefined);
  expect(comparisonEnvironmentParts(productExecutionEnvironment(), "/visp/own-cache")).toEqual(own);
});

it("includes explicitly declared application variables and nothing else", () => {
  vi.stubEnv("APP_MODE", "first");
  vi.stubEnv("PATH", "/first");
  const before = declaredEnvironment(["APP_MODE"]);
  vi.stubEnv("PATH", "/second");
  expect(declaredEnvironment(["APP_MODE"])).toEqual(before);
  vi.stubEnv("APP_MODE", "second");
  expect(declaredEnvironment(["APP_MODE"])).not.toEqual(before);
  expect(declaredEnvironment()).toEqual({});
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
