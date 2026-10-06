import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import type { Result } from "../../../../src/core/result.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import type { CriticPacket } from "../../../../src/workflow/product/critic-packet.js";
import { criticSelection, readCriticState } from "../../../../src/workflow/product/critic-store.js";
import {
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { deliveredReviewEvidenceIds } from "../../../../src/workflow/product/review-context.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review-request.js";
import type { independentReviewerContext } from "../../../../src/workflow/product/reviewer-handoff.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { productWorkspace } from "../../support/product-workspace.js";

function requireValue<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

type Context = Pick<
  ReturnType<typeof independentReviewerContext>,
  "evidence" | "interactionEvidence" | "sources" | "experiments"
>;
function answer(current: Context) {
  const ids = deliveredReviewEvidenceIds(
    current.evidence,
    current.interactionEvidence,
    current.sources,
    current.experiments,
  );
  expect(ids).toContain("CODE-CORE-GAPS");
  // Some delivered ordinary sources are absent from the bounded evidence list. They
  // already have catalogue records and must not acquire conflicting generated ones.
  expect(
    current.sources.some(
      (source) =>
        source.id !== "CODE-CORE-GAPS" && !current.evidence.some((entry) => entry.id === source.id),
    ),
  ).toBe(true);
  return {
    summary: "All supplied evidence inspected",
    assessments: [
      {
        outcome: "O001",
        status: "unclear",
        summary: "Delivered source remains incomplete",
        evidence: ids,
        expectations: [],
      },
    ],
    findings: [],
    limitations: [],
    resolutions: [],
    disputes: [],
  };
}

async function removeLegacyDelivery(workspace: WorkspaceState, mode: string) {
  if (!mode.startsWith("legacy-")) return;
  const selection = requireValue(await criticSelection(workspace, { task: "T001" }));
  const state = requireValue(await readCriticState(workspace, selection)).state;
  const attempt = state?.attempts.at(-1);
  if (!attempt) throw new Error("Missing critic attempt");
  delete attempt.deliveredEvidenceIds;
  delete attempt.deliveredGeneratedReferences;
  await writeFile(selection.path, JSON.stringify(state));
}

it.each(["session", "native", "legacy-native", "attached", "legacy-attached"])(
  "%s accepts all delivered IDs when source entries exceed the evidence-list limit",
  async (mode) => {
    const p = await productWorkspace({ critic: true });
    try {
      requireValue(
        await updateProductBrief(await p.workspace.state(), {
          brief: {
            ...p.brief,
            checks: [{ ...p.brief.checks[0], files: ["src/**", "test/**"] }],
            slices: [{ ...p.brief.slices[0], scope: { allowed: ["src/**", "test/**"] } }],
          },
          reason: "Exercise bounded citation metadata and legacy attempts",
        }),
      );
      // Within the scope-file limit, so every module stays core, but too large to fit together.
      for (let index = 0; index < 60; index++)
        await p.workspace.write(
          `src/module${index}.mjs`,
          `export const x${index}=${index};\n// ${"module context ".repeat(40)}\n`,
        );
      requireValue(await runProductWork(await p.workspace.state(), { task: "T001" }));
      await p.workspace.write("src/value.mjs", "export const value=2;\n");
      requireValue(await runProductVerify(await p.workspace.state(), { task: "T001" }));
      const workspace = await p.workspace.state();
      if (mode === "session") {
        const prepared = requireValue(
          await runProductReviewRequest(workspace, { prepare: true, task: "T001" }),
        ) as { packetPath: string; session: string };
        const packet = JSON.parse(
          requireValue(await workspace.files.readText(prepared.packetPath)),
        ) as Context;
        requireValue(
          await runProductReviewRequest(workspace, {
            session: prepared.session,
            assessments: answer(packet).assessments,
          }),
        );
        return;
      }
      const base = balancedCritic("codex");
      if (!base) throw new Error("Missing critic defaults");
      const config = { ...base, maxCalls: 2 };
      const capabilities = {
        harness: "codex" as const,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        freshContext: true,
        images: true,
        readOnly: true,
        delegationAllowed: true,
      };
      requireValue(
        await runProductCritic(workspace, { task: "T001", operation: "configure", config }),
      );
      if (mode.includes("attached")) {
        requireValue(
          await runProductCritic(
            workspace,
            { task: "T001", operation: "review" },
            {
              inspect: async () => capabilities,
              review: async (packet) => {
                await removeLegacyDelivery(workspace, mode);
                return {
                  model: config.model,
                  reasoningEffort: config.reasoningEffort,
                  context: "fresh",
                  response: answer(packet.current),
                };
              },
            },
          ),
        );
      } else {
        const prepared = requireValue(
          await runProductCritic(workspace, { task: "T001", operation: "prepare", capabilities }),
        ) as { packetPath: string; attempt: string };
        const packet = JSON.parse(
          requireValue(await workspace.files.readText(prepared.packetPath)),
        ) as CriticPacket;
        await removeLegacyDelivery(workspace, mode);
        requireValue(
          await runProductCritic(workspace, {
            task: "T001",
            operation: "submit",
            attempt: prepared.attempt,
            response: answer(packet.current),
            capabilities,
          }),
        );
      }
      const selected = requireValue(await criticSelection(workspace, { task: "T001" }));
      const attempt = requireValue(await readCriticState(workspace, selected)).state?.attempts.at(
        -1,
      );
      expect(attempt?.status, attempt?.message).toBe("reviewed");
      if (!mode.startsWith("legacy-")) {
        const references = attempt?.deliveredGeneratedReferences ?? [];
        expect(references.filter((entry) => !entry.sourceKind).map((entry) => entry.id)).toEqual([
          "CODE-CORE-GAPS",
        ]);
        const diffs = references.filter((entry) => entry.sourceKind === "implementation-diff");
        expect(diffs).toHaveLength(1);
        for (const diff of diffs) expect(attempt?.deliveredEvidenceIds).toContain(diff.id);
      }
    } finally {
      await p.workspace.destroy();
    }
  },
);
