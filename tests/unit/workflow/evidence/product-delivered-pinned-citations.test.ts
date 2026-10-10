import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { balancedCritic } from "../../../../src/config/critic.js";
import { hashValue, sha256 } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import type { CriticState } from "../../../../src/workflow/product/critic-model.js";
import type { CriticPacket } from "../../../../src/workflow/product/critic-packet.js";
import { criticSelection, readCriticState } from "../../../../src/workflow/product/critic-store.js";
import { runProductHostFeedback } from "../../../../src/workflow/product/host-feedback.js";
import { runProductVerify, runProductWork } from "../../../../src/workflow/product/index.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { deliveredReviewEvidenceIds } from "../../../../src/workflow/product/review-context.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review-request.js";
import type { independentReviewerContext } from "../../../../src/workflow/product/reviewer-handoff.js";
import { type ProductRecord, readProductRecord } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";

function requireValue<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

type Context = ReturnType<typeof independentReviewerContext>;
type Scenario = "delivered pinned" | "generated limitation" | "undelivered pinned";

function expectSubmission(result: Result<unknown>, scenario: Scenario) {
  if (scenario !== "undelivered pinned") return requireValue(result);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("Unknown evidence reference");
}

function answer(
  current: Pick<Context, "evidence" | "interactionEvidence" | "sources" | "experiments">,
  scenario: Scenario,
  pinnedCandidate: string,
) {
  const ids = deliveredReviewEvidenceIds(
    current.evidence,
    current.interactionEvidence,
    current.sources,
    current.experiments,
  );
  if (scenario === "generated limitation") {
    const gap = current.sources.find((source) => source.id === "CODE-CORE-GAPS");
    expect(gap?.available).toBe(false);
    expect(ids).toContain("CODE-CORE-GAPS");
  } else
    expect(current.sources.some((source) => source.reference.endsWith("oracle5.txt"))).toBe(true);
  if (scenario === "undelivered pinned") expect(ids).not.toContain(pinnedCandidate);
  expect(current.sources.some((source) => source.kind === "authored-brief")).toBe(false);
  return {
    summary: "All delivered evidence inspected",
    assessments: [
      {
        outcome: "O001",
        status: "unclear",
        summary: "Inspection remains uncertain",
        evidence: scenario === "undelivered pinned" ? [pinnedCandidate] : ids,
        expectations: [],
      },
    ],
    findings: [],
    limitations: [],
    resolutions: [],
    disputes: [],
  };
}

function expectAttempt(attempt: CriticState["attempts"][number] | undefined, scenario: Scenario) {
  expect(attempt?.status, attempt?.message).toBe(
    scenario === "undelivered pinned" ? "unavailable" : "reviewed",
  );
  if (scenario === "undelivered pinned")
    expect(attempt?.message).toContain("Unknown evidence reference");
  if (scenario === "generated limitation") {
    expect(attempt?.deliveredGeneratedReferences).toEqual([
      expect.objectContaining({
        id: "CODE-CORE-GAPS",
        kind: "source",
        status: "unavailable",
      }),
    ]);
    expect(attempt?.deliveredSourceManifest).toBeUndefined();
  }
}

function expectRecordedReview(
  reviewed: ProductRecord["state"]["reviews"][number] | undefined,
  scenario: Scenario,
) {
  if (scenario === "undelivered pinned") expect(reviewed).toBeUndefined();
  else {
    expect(reviewed?.assessments[0]?.status).toBe("unclear");
    expect(reviewed?.assessments[0]?.evidence).toContain(
      scenario === "generated limitation" ? "CODE-CORE-GAPS" : "SRC-5b8c44a84483f60b",
    );
  }
}

const cases = ["session", "native", "attached", "inline"].flatMap((mode) =>
  (["delivered pinned", "generated limitation", "undelivered pinned"] as const).map(
    (scenario) => [mode, scenario] as const,
  ),
);
it.each(cases)(
  "%s review validates %s references against its delivered packet",
  async (mode, scenario) => {
    const p = await productWorkspace({ critic: true });
    try {
      await p.workspace.write(
        "src/value.mjs",
        `export const value = 2;\n${scenario === "generated limitation" ? "// unused implementation context\n".repeat(2000) : `//${"x".repeat(16000)}`}`,
      );
      const state = await p.workspace.state();
      const record = requireValue(await readProductRecord(state));
      const files: { path: string; sha256: string }[] = [];
      for (let index = 0; index < 20; index++) {
        const path = `oracle${index}.txt`;
        const text = `Oracle ${index}\n${"y".repeat(1990)}`;
        await p.workspace.write(path, text);
        files.push({ path, sha256: sha256(text) });
      }
      record.brief.acceptanceBaseline = [
        {
          command: [process.execPath, "test/value.test.mjs"],
          files: files as [{ path: string; sha256: string }, ...{ path: string; sha256: string }[]],
        },
      ];
      record.state.intentSnapshot.acceptanceBaseline = record.brief.acceptanceBaseline;
      record.state.briefDigest = hashValue(record.brief);
      await writeFile(
        state.paths.featureFile(record.brief.feature, "brief.yaml"),
        stringify(record.brief),
      );
      await writeFile(
        state.paths.featureFile(record.brief.feature, "product-state.json"),
        JSON.stringify(record.state),
      );
      requireValue(await runProductWork(await p.workspace.state(), { task: "T001" }));
      requireValue(await runProductVerify(await p.workspace.state(), { task: "T001" }));
      const candidates = requireValue(await runProductReview(state, { task: "T001" }));
      const pinnedCandidate = candidates.sources.find((source) =>
        source.reference.endsWith("oracle19.txt"),
      );
      if (!pinnedCandidate) throw new Error("Missing pinned candidate");
      const responseFor = (packet: Parameters<typeof answer>[0]) =>
        answer(packet, scenario, pinnedCandidate.id);
      if (mode === "session") {
        const prepared = requireValue(
          await runProductReviewRequest(state, { prepare: true, task: "T001" }),
        ) as { packetPath: string; session: string };
        const packet = JSON.parse(
          requireValue(await state.files.readText(prepared.packetPath)),
        ) as Context;
        expectSubmission(
          await runProductReviewRequest(state, {
            session: prepared.session,
            assessments: responseFor(packet).assessments,
          }),
          scenario,
        );
      } else if (mode === "inline") {
        expectSubmission(
          await runProductHostFeedback(
            state,
            { model: "independent-fixture", review: async (packet) => responseFor(packet) },
            { task: "T001" },
          ),
          scenario,
        );
      } else {
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
          await runProductCritic(state, { task: "T001", operation: "configure", config }),
        );
        if (mode === "native") {
          const prepared = requireValue(
            await runProductCritic(state, { task: "T001", operation: "prepare", capabilities }),
          ) as { packetPath: string; attempt: string };
          const packet = JSON.parse(
            requireValue(await state.files.readText(prepared.packetPath)),
          ) as CriticPacket;
          requireValue(
            await runProductCritic(state, {
              task: "T001",
              operation: "submit",
              attempt: prepared.attempt,
              response: responseFor(packet.current),
              capabilities,
            }),
          );
        } else {
          requireValue(
            await runProductCritic(
              state,
              { task: "T001", operation: "review" },
              {
                inspect: async () => capabilities,
                review: async (packet) => ({
                  model: config.model,
                  reasoningEffort: config.reasoningEffort,
                  context: "fresh",
                  response: responseFor(packet.current),
                }),
              },
            ),
          );
        }
        const selection = requireValue(await criticSelection(state, { task: "T001" }));
        const attempt = requireValue(await readCriticState(state, selection)).state?.attempts.at(
          -1,
        );
        expectAttempt(attempt, scenario);
      }
      const reviewed = requireValue(await readProductRecord(state)).state.reviews.at(-1);
      expectRecordedReview(reviewed, scenario);
    } finally {
      await p.workspace.destroy();
    }
  },
);
