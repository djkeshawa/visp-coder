import { readFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { runJson } from "../../cli/support/cli.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let project: TestWorkspace | undefined;
afterEach(async () => project?.destroy());

it.each([
  { limit: 1, policyLimit: undefined, refused: true },
  { limit: 2, policyLimit: undefined, refused: false },
  { limit: 1, policyLimit: 2, refused: false },
  { limit: 2, policyLimit: 1, refused: true },
])(
  "enforces the authored limit and recorded policy precedence: %j",
  async ({ limit, policyLimit, refused }) => {
    ({ workspace: project } = await productWorkspace());
    const initial = await project.state();
    const config = parse(await readFile(initial.paths.config, "utf8"));
    config.workflow.maxChangedFiles = limit;
    await project.write("visp.yml", stringify(config));
    if (policyLimit !== undefined)
      await project.write(
        ".visp/policy.json",
        JSON.stringify({ ...initial.policy, maxChangedFiles: policyLimit }),
      );
    expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
    await project.write("src/value.mjs", "export const value = 2;\n");
    const test = await readFile(`${project.root}/test/value.test.mjs`, "utf8");
    await project.write("test/value.test.mjs", `${test}\n// Also changed within declared scope.\n`);
    const result = await runJson<{ passed: boolean }>(project.root, "verify", "--task", "T001");
    if (refused) {
      expect(result.envelope).toMatchObject({
        ok: false,
        error: { code: "SCOPE_VIOLATION" },
      });
      expect(result.envelope.error?.message).toContain(
        "Changed-file count 2 exceeds configured limit 1",
      );
    } else {
      expect(result.envelope).toMatchObject({
        ok: true,
        data: { passed: true },
      });
    }
  },
);

it.each([true, false])(
  "enforces an authored blocked path even within the slice: blocked=%s",
  async (blocked) => {
    ({ workspace: project } = await productWorkspace());
    const initial = await project.state();
    const config = parse(await readFile(initial.paths.config, "utf8"));
    if (blocked) config.workflow.blockedPaths.push("src/value.mjs");
    await project.write("visp.yml", stringify(config));
    expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
    await project.write("src/value.mjs", "export const value = 2;\n");
    const result = await runJson<{ passed: boolean }>(project.root, "verify", "--task", "T001");
    expect(result.envelope).toMatchObject(
      blocked
        ? {
            ok: false,
            error: {
              code: "SCOPE_VIOLATION",
              details: { forbidden: ["src/value.mjs"] },
            },
          }
        : { ok: true, data: { passed: true } },
    );
  },
);
