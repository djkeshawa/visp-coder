import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { runProductVerify, runProductWork } from "../../../../src/workflow/product/index.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review-request.js";
import { runProductReviewerHandoff } from "../../../../src/workflow/product/reviewer-handoff.js";
import { compactProductReply } from "../../../../src/workflow/product-compact-text.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

async function ready(launched: boolean) {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  if (launched) {
    const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
    config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
    await workspace.write("visp.yml", stringify(config));
    workspace.commit("VISP launches the reviewer");
  }
  expect((await runProductWork(await workspace.state())).ok).toBe(true);
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(await workspace.state())).ok).toBe(true);
  return workspace;
}

const NOTICE = "VISP runs this project's reviewer inside visp done.";

it.each(["prepare", "handoff"] as const)(
  "puts an advisory notice first on a worker-run review --%s when VISP launches the reviewer",
  async (mode) => {
    const w = await ready(true);
    const result = await runProductReviewRequest(await w.state(), { [mode]: true, task: "T001" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const value = result.value as Record<string, unknown>;
    expect(Object.keys(value)[0]).toBe("notice");
    expect(value.notice).toContain(NOTICE);
    expect(value.notice).toContain("does not replace it");
    // The MCP and CLI compact replies keep it.
    expect(compactProductReply("visp_review", result.value, "mcp")).toContain(NOTICE);
    // The notice is added to the result, never a refusal: the usual fields remain.
    expect(Object.keys(value).length).toBeGreaterThan(1);
  },
);

it("leaves review --prepare and --handoff unchanged when the host reviews", async () => {
  const w = await ready(false);
  for (const mode of ["prepare", "handoff"] as const) {
    const result = await runProductReviewRequest(await w.state(), { [mode]: true, task: "T001" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(NOTICE);
  }
});

it("does not put the notice in the packet VISP builds for its own reviewer", async () => {
  const w = await ready(true);
  const handoff = await runProductReviewerHandoff(await w.state(), { task: "T001" });
  expect(handoff.ok, JSON.stringify(handoff)).toBe(true);
  expect(JSON.stringify(handoff)).not.toContain(NOTICE);
});
