import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ok } from "../../../../src/core/result.js";
import { withStateLock } from "../../../../src/core/state-lock.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { runProductDone, runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace;
afterEach(async () => workspace?.destroy());
async function setup(slow = false) {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  const check = fixture.brief.checks[0];
  if (!check) throw new Error("missing fixture check");
  expect(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...fixture.brief,
        checks: [
          check,
          {
            ...check,
            id: "C002",
            command: [
              process.execPath,
              "-e",
              slow
                ? "require('fs').writeFileSync('.visp/started', 'ready'); setTimeout(() => {}, 3000)"
                : "console.log('second check')",
            ],
          },
        ],
        slices: fixture.brief.slices.map((slice) => ({ ...slice, checks: ["C001", "C002"] })),
      },
      reason: "Two checks for interruption recovery",
    }),
  ).toMatchObject({ ok: true });
  expect(await runProductWork(await workspace.state())).toMatchObject({ ok: true });
  await workspace.write("src/value.mjs", "export const value = 2;\n");
}

it.each(["done", "verify"])(
  "%s persists each result before progress, cancels without closing, and resumes only remaining checks",
  async (operation) => {
    await setup();
    const controller = new AbortController();
    const progress: string[] = [];
    const run = operation === "done" ? runProductDone : runProductVerify;
    const interrupted = await run(await workspace.state(), {
      signal: controller.signal,
      onProgress: async (event) => {
        if (event.status !== "passed") return;
        progress.push(event.check);
        const record = await readProductRecord(await workspace.state());
        expect(
          record.ok && record.value.state.executions.some((entry) => entry.check === event.check),
        ).toBe(true);
        controller.abort();
      },
    });
    expect(interrupted).toMatchObject({ ok: false, error: { details: { cancelled: true } } });
    expect(progress).toEqual(["C001"]);
    const record = await readProductRecord(await workspace.state());
    expect(record.ok && record.value.state.slices.T001?.status).toBe("in-progress");
    const resumed = await run(await workspace.state());
    expect(resumed).toMatchObject({ ok: true, value: { executions: [{ check: "C002" }] } });
  },
);

it("releases writer ownership while checks run and honours cancellation in the subprocess", async () => {
  await setup(true);
  const controller = new AbortController();
  const running = runProductVerify(await workspace.state(), { signal: controller.signal });
  try {
    await vi.waitFor(
      async () =>
        expect(await readFile(join(workspace.root, ".visp/started"), "utf8")).toBe("ready"),
      { timeout: 10000 },
    );
    expect(
      await withStateLock(workspace.root, async () => ok("other writer"), { timeoutMs: 0 }),
    ).toEqual(ok("other writer"));
  } finally {
    controller.abort();
  }
  expect(await running).toMatchObject({ ok: false, error: { details: { cancelled: true } } });
});

it("preserves a concurrent state update when committing a completed check", async () => {
  await setup();
  let updated = false;
  const result = await runProductVerify(await workspace.state(), {
    onProgress: async (event) => {
      if (updated || event.status !== "running") return;
      updated = true;
      await withStateLock(workspace.root, async () => {
        const state = await workspace.state();
        const current = await readProductRecord(state);
        if (!current.ok) throw new Error(current.error.message);
        return saveProductState(state, current.value, {
          ...current.value.state,
          criticManual: true,
        });
      });
    },
  });
  expect(result).toMatchObject({ ok: true });
  const current = await readProductRecord(await workspace.state());
  expect(current.ok && current.value.state.criticManual).toBe(true);
});

it("refuses closeout after a concurrent brief revision without overwriting it", async () => {
  await setup();
  let updated = false;
  const result = await runProductDone(await workspace.state(), {
    onProgress: async (event) => {
      if (updated || event.status !== "running") return;
      updated = true;
      expect(
        await updateProductBrief(await workspace.state(), {
          patch: { uncertainties: ["Concurrent note"] },
          reason: "Concurrent update",
        }),
      ).toMatchObject({ ok: true });
    },
  });
  expect(result).toMatchObject({ ok: false, error: { code: "STATE_BUSY" } });
  const current = await readProductRecord(await workspace.state());
  expect(current.ok && current.value.brief.uncertainties).toEqual(["Concurrent note"]);
  expect(current.ok && current.value.state.slices.T001?.status).toBe("in-progress");
});
