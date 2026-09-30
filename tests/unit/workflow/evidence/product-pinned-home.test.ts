import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { acceptanceEnvironment } from "../../../../src/workflow/product/acceptance-environment.js";
import { executeProductCheck } from "../../../../src/workflow/product/check-execution.js";
import { productCheckSchema } from "../../../../src/workflow/product/model.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace;
afterEach(async () => {
  vi.unstubAllEnvs();
  await workspace?.destroy();
});

it("keeps the shared temporary directory as HOME when no private home is given", () => {
  const environment = acceptanceEnvironment({
    PATH: "/bin",
    TEMP: "/inherited/temp",
    TMP: "/inherited/tmp",
    SECRET: "x",
  });
  expect(environment).toEqual({
    PATH: "/bin",
    TEMP: "/inherited/temp",
    TMP: "/inherited/tmp",
    HOME: tmpdir(),
    USERPROFILE: tmpdir(),
    TMPDIR: tmpdir(),
  });
});

it("puts HOME and every temporary variable inside a private home when one is given", () => {
  const environment = acceptanceEnvironment(
    { PATH: "/bin", TEMP: "/elsewhere", SECRET: "x" },
    "/h",
  );
  expect(environment).toEqual({
    PATH: "/bin",
    HOME: "/h",
    USERPROFILE: "/h",
    TMPDIR: "/h/tmp",
    TEMP: "/h/tmp",
    TMP: "/h/tmp",
  });
});

async function execute(id: string, script: string) {
  ({ workspace } = await productWorkspace());
  const state = await workspace.state();
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  const check = productCheckSchema.parse({ id, command: [process.execPath, "-e", script] });
  return executeProductCheck(state, record.value, undefined, check, "subject");
}
const REPORT = `
const fs = require("node:fs");
const { HOME, TMPDIR, TEMP, TMP, USERPROFILE } = process.env;
fs.writeFileSync(TMPDIR + "/scratch", "x");
console.log("REPORT " + JSON.stringify({ HOME, TMPDIR, TEMP, TMP, USERPROFILE,
  mode: (fs.statSync(HOME).mode & 0o777).toString(8), scratch: fs.existsSync(TMPDIR + "/scratch") }));
`;

it("runs a pinned check in a private home that is gone afterwards", async () => {
  const result = await execute("PINNED_1", REPORT);
  expect(result.execution.status).toBe("passed");
  const line = /REPORT (.*)/.exec(result.execution.output)?.[1] ?? "";
  const seen = JSON.parse(line) as Record<string, string | boolean>;
  const home = String(seen.HOME);
  expect(home).toMatch(/\/visp-check-[A-Za-z0-9]{6}\/home$/);
  expect(seen).toMatchObject({
    TMPDIR: `${home}/tmp`,
    TEMP: `${home}/tmp`,
    TMP: `${home}/tmp`,
    USERPROFILE: home,
    mode: "700",
    scratch: true,
  });
  expect(existsSync(home)).toBe(false);
});

it("gives two pinned runs different homes", async () => {
  const first = await execute("PINNED_1", REPORT);
  const second = await execute("PINNED_1", REPORT);
  const homes = [first, second].map(
    (result) => JSON.parse(/REPORT (.*)/.exec(result.execution.output)?.[1] ?? "{}").HOME,
  );
  expect(homes[0]).not.toBe(homes[1]);
});

it("leaves an ordinary check the inherited HOME", async () => {
  vi.stubEnv("HOME", "/operator/home");
  const result = await execute(
    "C001",
    'console.log("REPORT " + JSON.stringify({ inherited: process.env.HOME === "/operator/home" }))',
  );
  expect(JSON.parse(/REPORT (.*)/.exec(result.execution.output)?.[1] ?? "{}")).toEqual({
    inherited: true,
  });
});

it("keeps a passing pinned check passed when it leaves a read-only directory in its home", async () => {
  const result = await execute(
    "PINNED_1",
    `const fs = require("node:fs");
fs.mkdirSync(process.env.HOME + "/mod/deep", { recursive: true });
fs.writeFileSync(process.env.HOME + "/mod/deep/file", "x");
fs.chmodSync(process.env.HOME + "/mod/deep", 0o500);
fs.chmodSync(process.env.HOME + "/mod", 0o500);
console.log("HOME_IS " + process.env.HOME);`,
  );
  expect(result.execution.status).toBe("passed");
  expect(result.execution.output).not.toContain("EACCES");
  const home = /HOME_IS (.*)/.exec(result.execution.output)?.[1] ?? "";
  expect(home).toMatch(/visp-check-/);
  expect(existsSync(home)).toBe(false);
});
