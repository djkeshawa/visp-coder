import { execFile } from "node:child_process";
import { readFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { buildMigrationProgram } from "../../../src/migration/main.js";
import { readProductRecord } from "../../../src/workflow/product/store.js";
import { TestWorkspace } from "../support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  for (const w of workspaces.splice(0)) await w.destroy();
});
it("exposes only explicit preview, export and apply operations", () => {
  expect(buildMigrationProgram().commands.map((command) => command.name())).toEqual([
    "preview",
    "apply",
    "export",
  ]);
});
it("runs the built standalone executable through an installed-style symlink", async () => {
  const w = await TestWorkspace.create({ "app.js": "export const value=1;" });
  workspaces.push(w);
  await w.withFeature("001-history", [
    { id: "T001", allowedFiles: ["app.js"] },
    { id: "T002", allowedFiles: ["app.js"] },
    { id: "T003", allowedFiles: ["app.js"] },
  ]);
  const tasksPath = ".visp/features/001-history/tasks.json";
  const tasks = JSON.parse(await readFile(join(w.root, tasksPath), "utf8"));
  tasks.tasks[0].taskClass = "bugfix";
  delete tasks.tasks[1].taskClass;
  tasks.tasks[2].taskClass = "feature";
  const originalTasks = JSON.stringify(tasks);
  await w.write(tasksPath, originalTasks);
  const bin = join(w.root, "visp-migrate");
  await symlink(resolve("dist/migrate.js"), bin);
  async function call(...args: string[]) {
    const result = await promisify(execFile)(
      process.execPath,
      [bin, "--project", w.root, ...args],
      { timeout: 30000 },
    );
    return JSON.parse(result.stdout);
  }
  expect(await call("preview")).toMatchObject({ ok: true, data: { operation: "preview" } });
  const exported = await call("export", "--name", "original");
  expect(exported.ok).toBe(true);
  const snapshot = JSON.parse(await readFile(join(w.root, exported.data.path), "utf8"));
  expect(snapshot.files.some((file: { path: string }) => file.path.endsWith("intent.json"))).toBe(
    true,
  );
  expect(await call("apply")).toMatchObject({
    ok: true,
    data: { operation: "apply", backup: expect.any(String) },
  });
  const record = await readProductRecord(await w.state(), { feature: "001-history" });
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.brief.slices.map((slice) => slice.taskClass)).toEqual([
    "bugfix",
    undefined,
    "feature",
  ]);
  expect(await readFile(join(w.root, tasksPath), "utf8")).toBe(originalTasks);
  expect(await call("apply")).toMatchObject({ ok: true, data: { changed: 0 } });
});
