import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ok } from "../../../src/core/result.js";
import {
  inspectStateLock,
  STATE_LOCK_DIRECTORY,
  withStateLock,
} from "../../../src/core/state-lock.js";
import { runChecks } from "../../../src/doctor/checks.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace;
beforeEach(async () => {
  workspace = await TestWorkspace.create({ "src/value.ts": "export const value = 1;\n" });
});
afterEach(async () => workspace.destroy());

it("reports an active writer without recovering or changing its ownership", async () => {
  const state = await workspace.state();
  const result = await withStateLock(workspace.root, async () => {
    const ownerPath = join(workspace.root, STATE_LOCK_DIRECTORY, "owner.json");
    const before = await readFile(ownerPath, "utf8");
    const report = await runChecks(state, { guardHandshake: async () => ok(undefined) });
    expect(report.checks).toContainEqual({
      name: "state ownership",
      status: "warn",
      detail: `VISP process ${process.pid} is writing; retry after it finishes`,
    });
    expect(report.checks).toContainEqual({
      name: "file transactions",
      status: "warn",
      detail: "Another active writer may be applying a transaction; it will not be recovered",
    });
    expect(await readFile(ownerPath, "utf8")).toBe(before);
    expect(await inspectStateLock(workspace.root)).toMatchObject({
      ok: true,
      value: { state: "active" },
    });
    return ok(undefined);
  });
  expect(result.ok).toBe(true);
  expect(await inspectStateLock(workspace.root)).toEqual(ok({ state: "unlocked" }));
});

it.each(["ambiguous", "abandoned"] as const)(
  "reports %s ownership with the appropriate recovery and preserves the original record",
  async (ownership) => {
    const state = await workspace.state();
    const directory = join(workspace.root, STATE_LOCK_DIRECTORY);
    await mkdir(directory, { recursive: true });
    const ownerPath = join(directory, "owner.json");
    const before =
      ownership === "ambiguous"
        ? "{unreadable owner"
        : JSON.stringify({
            version: 1,
            token: randomUUID(),
            pid: Number(
              execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }),
            ),
            host: hostname(),
            createdAt: new Date().toISOString(),
          });
    await writeFile(ownerPath, before);
    expect(await inspectStateLock(workspace.root)).toMatchObject({
      ok: true,
      value: { state: ownership },
    });
    const report = await runChecks(state, { guardHandshake: async () => ok(undefined) });
    expect(report.verdict).toBe("unhealthy");
    expect(report.checks).toContainEqual({
      name: "state ownership",
      status: "fail",
      detail:
        ownership === "abandoned"
          ? "The previous mutation owner has exited"
          : "Mutation ownership cannot be established; no automatic lock deletion is safe",
      recovery:
        ownership === "abandoned"
          ? "visp doctor --fix"
          : `Inspect ${STATE_LOCK_DIRECTORY}/owner.json and the named host before recovering ownership`,
    });
    expect(await readFile(ownerPath, "utf8")).toBe(before);
  },
);
