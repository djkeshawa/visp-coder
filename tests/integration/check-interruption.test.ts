import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { updateProductBrief } from "../../src/workflow/product/brief.js";
import { readProductRecord } from "../../src/workflow/product/store.js";
import { runProductWork } from "../../src/workflow/product/work.js";
import { productWorkspace } from "../unit/support/product-workspace.js";

it("prints CLI progress and preserves completed checks when the host sends SIGTERM", async () => {
  const { workspace, brief } = await productWorkspace();
  try {
    const check = brief.checks[0];
    if (!check) throw new Error("missing check");
    expect(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          checks: [
            check,
            {
              ...check,
              id: "C002",
              command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
            },
          ],
          slices: brief.slices.map((slice) => ({ ...slice, checks: ["C001", "C002"] })),
        },
        reason: "Exercise host interruption",
      }),
    ).toMatchObject({ ok: true });
    expect(await runProductWork(await workspace.state())).toMatchObject({ ok: true });
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
        "--project",
        workspace.root,
        "done",
        "--json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    let stdout = "",
      stderr = "",
      cancelled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
      if (!cancelled && stderr.includes("C001: passed")) {
        cancelled = true;
        child.kill("SIGTERM");
      }
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("close", resolve);
        child.once("error", reject);
      });
      expect(cancelled).toBe(true);
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        error: { details: { cancelled: true } },
      });
      const record = await readProductRecord(await workspace.state());
      expect(record.ok && record.value.state.executions).toMatchObject([
        { check: "C001", status: "passed" },
      ]);
      expect(record.ok && record.value.state.slices.T001?.status).toBe("in-progress");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  } finally {
    await workspace.destroy();
  }
});
