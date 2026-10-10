import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectStateLock } from "../../../src/core/state-lock.js";
import { updateProductBrief } from "../../../src/workflow/product/brief.js";
import { readProductRecord } from "../../../src/workflow/product/store.js";
import { startProductProject } from "./resource-fixture.js";

let project: Awaited<ReturnType<typeof startProductProject>>;
afterEach(async () => project?.close());

it("forwards MCP cancellation, emits check progress and leaves the slice open", async () => {
  project = await startProductProject();
  const check = project.brief.checks[0];
  if (!check) throw new Error("missing check");
  expect(
    await updateProductBrief(await project.workspace.state(), {
      brief: {
        ...project.brief,
        checks: [
          {
            ...check,
            command: [
              process.execPath,
              "-e",
              "require('fs').writeFileSync('.visp/started', 'ready'); setTimeout(() => {}, 10000)",
            ],
          },
        ],
      },
      reason: "Exercise cancellation",
    }),
  ).toMatchObject({ ok: true });
  await project.client.callTool({ name: "visp_work", arguments: { task: "T001" } });
  const controller = new AbortController();
  const progress: string[] = [];
  const call = project.client
    .callTool({ name: "visp_done", arguments: { task: "T001" } }, undefined, {
      signal: controller.signal,
      onprogress: (event) => {
        progress.push(event.message ?? "");
      },
    })
    .catch((error: unknown) => error);
  try {
    await vi.waitFor(
      async () => expect(await readFile(join(project.root, ".visp/started"), "utf8")).toBe("ready"),
      { timeout: 10000 },
    );
    expect(progress).toContain("C001: running");
    expect(await inspectStateLock(project.root)).toMatchObject({
      ok: true,
      value: { state: "unlocked" },
    });
  } finally {
    controller.abort();
    await call;
  }
  await vi.waitFor(async () =>
    expect(await inspectStateLock(project.root)).toMatchObject({
      ok: true,
      value: { state: "unlocked" },
    }),
  );
  const record = await readProductRecord(await project.workspace.state());
  expect(record.ok && record.value.state.slices.T001?.status).toBe("in-progress");
  expect(record.ok && record.value.state.executions).toEqual([]);
});
