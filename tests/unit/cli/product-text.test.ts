import { afterEach, expect, it } from "vitest";
import { productWorkspace } from "../support/product-workspace.js";
import type { TestWorkspace } from "../support/workspace.js";
import { runCli, runJson } from "./support/cli.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

// Models drive VISP through a shell as often as through MCP; they read the text output.
it("prints compact text for done and keeps the complete result behind --json", async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  expect((await runCli(workspace.root, "work")).exitCode).toBe(0);
  await workspace.write("src/value.mjs", "export const value = 3;\n");
  const text = await runCli(workspace.root, "done");
  const json = await runJson<{ executions: unknown[] }>(workspace.root, "done");
  expect(text.stdout).toMatch(/^done: \{/);
  expect(text.stdout).toContain('"passed":false');
  expect(text.stdout).toContain("Full result: add --json.");
  expect(text.stdout.length).toBeLessThan(json.stdout.length / 2);
  expect(json.envelope.data?.executions.length).toBeGreaterThan(0);
});

it("acknowledges a CLI brief update without reprinting the brief, but prints a brief read in full", async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  await workspace.write(".visp/patch.json", JSON.stringify({ uncertainties: ["Which runtime?"] }));
  const updated = await runCli(
    workspace.root,
    "brief",
    "--patch",
    ".visp/patch.json",
    "--reason",
    "Record an open question",
  );
  expect(updated.exitCode, updated.stderr).toBe(0);
  expect(updated.stdout).toMatch(/^brief: \{/);
  expect(updated.stdout).toContain(`visp next --feature ${fixture.brief.feature}`);
  const read = await runCli(workspace.root, "brief");
  expect(read.stdout).toContain('"originalRequest"');
});
