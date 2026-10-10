import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));

it.each([
  ["next", "--bogus", "--json"],
  ["critic", "defaults", "--model", "x", "--json"],
  ["override", "create", "scope", "--reason", "test", "--days", "abc", "--json"],
])("returns a JSON usage error for %s", (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
});
