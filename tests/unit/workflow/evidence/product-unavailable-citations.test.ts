import { expect, it } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import type { Result } from "../../../../src/core/result.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import { criticSelection, readCriticState } from "../../../../src/workflow/product/critic-store.js";
import {
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";

function requireValue<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

// Every voxel-scene run lost its reviews this way: the reviewer opened the rendered PNG that
// VISP listed only as an unavailable core file and cited it beside the passing check.
it("keeps a review that cites unavailable evidence beside a current check run", async () => {
  const p = await productWorkspace({ critic: true });
  try {
    requireValue(
      await updateProductBrief(await p.workspace.state(), {
        brief: {
          ...p.brief,
          checks: [{ ...p.brief.checks[0], files: ["src/**", "test/**"] }],
          slices: [{ ...p.brief.slices[0], scope: { allowed: ["src/**", "test/**"] } }],
        },
        reason: "Make delivered source incomplete so VISP lists core gaps",
      }),
    );
    for (let index = 0; index < 60; index++)
      await p.workspace.write(
        `src/module${index}.mjs`,
        `export const x${index}=${index};\n// ${"module context ".repeat(40)}\n`,
      );
    requireValue(await runProductWork(await p.workspace.state(), { task: "T001" }));
    await p.workspace.write("src/value.mjs", "export const value=2;\n");
    requireValue(await runProductVerify(await p.workspace.state(), { task: "T001" }));
    const workspace = await p.workspace.state();
    const base = balancedCritic("codex");
    if (!base) throw new Error("Missing critic defaults");
    const config = { ...base, maxCalls: 2 };
    requireValue(
      await runProductCritic(workspace, { task: "T001", operation: "configure", config }),
    );
    let cited: string[] = [];
    requireValue(
      await runProductCritic(
        workspace,
        { task: "T001", operation: "review" },
        {
          inspect: async () => ({
            harness: "codex" as const,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            freshContext: true,
            images: true,
            readOnly: true,
            delegationAllowed: true,
          }),
          review: async (packet) => {
            const run = packet.current.evidence.find(
              (entry) => entry.kind === "execution" && entry.status === "available",
            );
            const gaps = packet.current.sources.find((source) => source.id === "CODE-CORE-GAPS");
            if (!run || !gaps) throw new Error("Expected a check run and the core-gaps note");
            cited = [run.id, gaps.id];
            return {
              model: config.model,
              reasoningEffort: config.reasoningEffort,
              context: "fresh",
              response: {
                summary: "The check passed and the module returns two.",
                assessments: [
                  {
                    outcome: "O001",
                    status: "satisfied",
                    summary: "The passing check exercises the public value.",
                    evidence: cited,
                    expectations: [],
                  },
                ],
                findings: [
                  {
                    problem: "Sixty unrelated modules sit beside the value module",
                    consequence: "Readers must skip code nothing imports",
                    nextCheck: "Remove modules nothing imports",
                    outcomes: ["O001"],
                    required: false,
                    evidence: cited,
                  },
                ],
                limitations: [],
                resolutions: [],
                disputes: [],
              },
            };
          },
        },
      ),
    );
    const selected = requireValue(await criticSelection(workspace, { task: "T001" }));
    const attempt = requireValue(await readCriticState(workspace, selected)).state?.attempts.at(-1);
    expect(attempt?.status, attempt?.message).toBe("reviewed");
    const record = requireValue(await readProductRecord(await p.workspace.state()));
    const review = record.state.reviews.at(-1);
    expect(review?.feedback?.limitations).toContain(
      "VISP dropped citations of evidence it could not deliver: CODE-CORE-GAPS",
    );
    const assessment = review?.assessments.at(-1);
    expect(assessment).toMatchObject({ outcome: "O001", status: "satisfied" });
    expect(assessment?.evidence).not.toContain("CODE-CORE-GAPS");
    expect(assessment?.summary).toContain(
      "VISP dropped citations of evidence it could not deliver: CODE-CORE-GAPS",
    );
  } finally {
    await p.workspace.destroy();
  }
});
