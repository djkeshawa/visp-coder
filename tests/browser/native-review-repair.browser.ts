import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { balancedCritic } from "../../src/config/critic.js";
import { sha256 } from "../../src/core/hash.js";
import type { Result } from "../../src/core/result.js";
import { runProductCapture } from "../../src/workflow/evidence/product-capture.js";
import { type CriticPacket, runProductCritic } from "../../src/workflow/product/critic.js";
import { currentJourneyFailures } from "../../src/workflow/product/evidence-references.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReproduction,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../src/workflow/product/index.js";
import { readProductRecord } from "../../src/workflow/product/store.js";
import { productSourceDigest } from "../../src/workflow/product/subject.js";
import { runJson } from "../unit/cli/support/cli.js";
import { legacyReview } from "../unit/support/legacy-critic.js";
import { productWorkspace } from "../unit/support/product-workspace.js";

const config = balancedCritic("codex");
if (!config) throw new Error("missing codex critic preset");

const capabilities = {
  harness: "codex",
  model: config.model,
  reasoningEffort: "high" as const,
  freshContext: true,
  images: true,
  readOnly: true,
  delegationAllowed: true,
};

const fixedPage = (fixed: boolean, keyboardBroken = false) => `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<button id="act" style="margin:40px;padding:32px;font-size:24px">Increment</button>
<output id="result" aria-live="polite">0</output>
<script>
  let count = 0;
  document.querySelector('#act').addEventListener('click', (event) => {
    ${keyboardBroken ? "if (event.detail === 0) return;" : ""}
    ${fixed ? "" : "if (count > 0) return;"}
    document.querySelector('#result').textContent = String(++count);
  });
</script>`;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function reviewResponse(
  packet: CriticPacket,
  options: { finding?: boolean; resolutionId?: string; laterReproduction?: boolean } = {},
) {
  const base = legacyReview(packet);
  const imageId = packet.current.images[0]?.id;
  if (!imageId) throw new Error("native packet did not contain a current image");
  const finding = {
    dimension: "functional" as const,
    problem: "A repeated click is ignored after the first increment.",
    nextCheck: "Replay the exact two click journey and observe the result reach 2.",
    outcomes: [packet.current.outcomes[0]?.id ?? "O001"],
    required: true,
    evidence: [imageId],
  };
  const execution = packet.current.evidence.find(
    (entry) => entry.kind === "execution" && entry.status === "available",
  )?.id;
  const implementation = packet.current.sources.find(
    (source) => source.kind === "implementation-file",
  )?.id;
  if (options.laterReproduction) finding.evidence = [implementation ?? "SRC-REQUEST"];
  const feedback = {
    ...base.feedback,
    dimensions: options.finding
      ? base.feedback.dimensions
      : [
          {
            dimension: "fidelity" as const,
            status: "satisfied" as const,
            reason: "The repaired behavior matches the retained request.",
            evidence: ["SRC-REQUEST"],
          },
          {
            dimension: "functional" as const,
            status: "satisfied" as const,
            reason: "The fresh browser check reaches 2 after the repeated click.",
            evidence: [execution ?? imageId],
          },
          {
            dimension: "non-functional" as const,
            status: "not-applicable" as const,
            reason: "The fixture makes no additional non-functional promise.",
            evidence: [],
          },
          {
            dimension: "experience" as const,
            status: "not-applicable" as const,
            reason: "The fixture tests a functional counter behavior only.",
            evidence: [],
          },
          {
            dimension: "code" as const,
            status: implementation ? ("satisfied" as const) : ("not-applicable" as const),
            reason: "The small handler owns the counter state clearly.",
            evidence: implementation ? [implementation] : [],
          },
        ],
    findings: options.finding ? [finding] : [],
    resolutions: options.resolutionId
      ? [
          {
            id: options.resolutionId,
            explanation: "The repaired implementation reaches 2 in the fresh execution.",
            regression: {
              kind: "checked" as const,
              explanation:
                "Keyboard activation still increments the counter after the pointer repair.",
              evidence: [
                packet.current.evidence.find(
                  (entry) =>
                    entry.kind === "execution" &&
                    entry.status === "available" &&
                    entry.summary.startsWith("C002:"),
                )?.id ?? "missing-keyboard-regression",
              ],
            },
            evidence: [
              packet.current.evidence.find(
                (entry) => entry.kind === "execution" && entry.status === "available",
              )?.id ?? imageId,
            ],
          },
        ]
      : [],
  };
  return {
    review: {
      ...base,
      assessments: packet.current.outcomes.map((outcome) => ({
        outcome: outcome.id,
        status: execution ? ("satisfied" as const) : ("unclear" as const),
        summary: execution
          ? "The current browser check passed."
          : "The failing journey needs repair.",
        evidence: execution ? [execution] : [],
        expectations: [],
      })),
      feedback,
    },
    comparison: [],
  };
}

it.each([false, true])(
  "keeps native review bounded across browser repair (later reproduction: %s)",
  async (laterReproduction) => {
    const setup = await productWorkspace({ critic: true });
    const { workspace } = setup;
    const url = pathToFileURL(join(workspace.root, "index.html")).href;
    const journey = {
      url,
      viewport: { width: 800, height: 600 },
      actions: [
        { kind: "click" as const, selector: "#act", capture: true },
        {
          kind: "wait-for" as const,
          selector: "#result",
          text: "1",
          timeoutMs: 600,
          capture: true,
        },
        { kind: "click" as const, selector: "#act", capture: true },
        {
          kind: "wait-for" as const,
          selector: "#result",
          text: "2",
          timeoutMs: 600,
          capture: true,
        },
      ],
    };
    try {
      await workspace.write("index.html", fixedPage(false));
      const amended = await updateProductBrief(await workspace.state(), {
        brief: {
          ...setup.brief,
          goal: "Increment the counter for every click",
          outcomes: [
            {
              id: "O001",
              kind: "functional",
              statement: "Every click increments the visible counter",
              priority: "must",
              provenance: "user-stated",
            },
          ],
          checks: [
            {
              id: "C001",
              command: { kind: "browser-journey", journey },
              outcomes: ["O001"],
              files: ["index.html"],
              environment: "browser",
            },
            {
              id: "C002",
              command: {
                kind: "browser-journey",
                journey: {
                  url,
                  viewport: journey.viewport,
                  actions: [
                    { kind: "key", key: "Tab" },
                    { kind: "key", key: "Enter" },
                    { kind: "wait-for", selector: "#result", text: "1", timeoutMs: 600 },
                  ],
                },
              },
              outcomes: ["O001"],
              files: ["index.html"],
              environment: "browser",
            },
          ],
          slices: [
            {
              id: "T001",
              goal: "Make repeated clicks increment the counter",
              outcomes: ["O001"],
              scope: { allowed: ["index.html"], expected: ["index.html"], forbidden: [] },
              checks: ["C001", "C002"],
            },
          ],
        },
        reason: "Use one complete browser journey for the repeated input behavior",
        intentChange: {
          reason: "Define the browser behavior exercised by this regression fixture",
          provenance: "test fixture",
        },
      });
      if (!amended.ok) throw new Error(amended.error.message);
      expect((await runProductWork(await workspace.state(), { task: "T001" })).ok).toBe(true);

      const failed = unwrap(
        await runProductCapture(await workspace.state(), { task: "T001", journey }),
      );
      expect(failed.status).toBe("timed-out");
      expect(failed.captures.length).toBeGreaterThan(0);
      for (const capture of failed.captures)
        expect(sha256(await readFile(join(workspace.root, capture.path)))).toBe(capture.sha256);

      const state = await workspace.state();
      expect(
        unwrap(await runProductCritic(state, { task: "T001", operation: "configure", config })),
      ).toMatchObject({ configured: true });
      const prepared = unwrap(
        await runProductCritic(await workspace.state(), {
          task: "T001",
          operation: "prepare",
          capabilities,
        }),
      ) as { attempt: string; packetPath: string; responsePath: string; capabilitiesPath: string };
      const oldPacketBytes = await readFile(prepared.packetPath);
      const oldPacket = JSON.parse(oldPacketBytes.toString()) as CriticPacket;
      expect(oldPacket.current.images.length).toBeGreaterThan(0);
      for (const image of oldPacket.current.images) {
        const imagePath = (image as unknown as { imagePath: string }).imagePath;
        expect(sha256(await readFile(imagePath))).toBe(
          (image as unknown as { sha256: string }).sha256,
        );
      }
      expect(oldPacket.current.images.every((image) => !("data" in image))).toBe(true);
      expect(oldPacketBytes.toString()).not.toMatch(/"data"\s*:\s*"[A-Za-z0-9+/=]{8,}"/);

      expect(await runProductWork(await workspace.state(), { task: "T001" })).toMatchObject({
        ok: false,
        error: { code: "STATE_BUSY", message: expect.stringContaining("review is pending") },
      });
      const guarded = await runJson<{ allowed: boolean; violations: { reason: string }[] }>(
        workspace.root,
        "guard",
        "--path",
        "index.html",
      );
      expect(guarded.exitCode).not.toBe(0);
      expect(guarded.envelope.data).toMatchObject({
        allowed: false,
        violations: [expect.objectContaining({ reason: "review-pending" })],
      });

      const firstSubmission = unwrap(
        await runProductCritic(await workspace.state(), {
          task: "T001",
          operation: "submit",
          result: {
            attempt: prepared.attempt,
            model: config.model,
            reasoningEffort: "high",
            context: "fresh",
            outputTokens: 500,
            response: reviewResponse(oldPacket, { finding: true, laterReproduction }),
          },
        }),
      ) as { action: string };
      expect(firstSubmission).toMatchObject({ action: "worker", callsUsed: 1 });
      expect(await runProductAccept(await workspace.state())).toMatchObject({
        ok: false,
        error: { code: "STAGE_BLOCKED" },
      });
      const repairWork = unwrap(await runProductWork(await workspace.state(), { task: "T001" }));
      const findingId = repairWork.feedbackPlan?.findings[0]?.id;
      expect(findingId).toMatch(/^FB-/);
      expect(repairWork.feedbackPlan?.findings[0]?.nextCheck).toContain(
        "Replay the exact two click journey",
      );

      if (laterReproduction) {
        await workspace.write("index.html", `${fixedPage(false)}<!-- later reproduction -->`);
        const reproduced = unwrap(
          await runProductVerify(await workspace.state(), { task: "T001" }),
        );
        const execution = reproduced.executions.find((entry) => entry.check === "C001");
        expect(execution?.status).toBe("failed");
        expect(execution?.subjectDigest).not.toBe(oldPacket.current.subjectDigest);
        unwrap(
          await runProductReproduction(await workspace.state(), {
            finding: findingId,
            execution: execution?.id,
            task: "T001",
            explanation:
              "Two real pointer clicks leave the counter at 1, reproducing the ignored repeated click report",
          }),
        );
      }

      const shallow = unwrap(
        await runProductCapture(await workspace.state(), {
          task: "T001",
          journey: {
            ...journey,
            actions: journey.actions.slice(0, 2),
          },
        }),
      );
      expect(shallow.status).toBe("completed");
      const beforeEdit = unwrap(await readProductRecord(await workspace.state()));
      const beforeSubject = unwrap(await productSourceDigest(await workspace.state()));
      expect(currentJourneyFailures(beforeEdit, beforeSubject, "T001").join(" ")).toContain(
        "Browser timed-out",
      );
      expect(
        (beforeEdit.state.captureRuns as { id?: string }[]).some((run) => run.id === failed.runId),
      ).toBe(true);

      await workspace.write("index.html", fixedPage(true, true));
      const regressed = unwrap(await runProductVerify(await workspace.state(), { task: "T001" }));
      expect(regressed.passed).toBe(false);
      expect(regressed.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ check: "C001", status: "passed" }),
          expect.objectContaining({ check: "C002", status: "failed" }),
        ]),
      );
      await workspace.write("index.html", fixedPage(true));
      const afterSubject = unwrap(await productSourceDigest(await workspace.state()));
      expect(afterSubject).not.toBe(beforeSubject);
      expect(await readFile(prepared.packetPath)).toEqual(oldPacketBytes);
      expect(
        await runProductCritic(await workspace.state(), {
          task: "T001",
          operation: "submit",
          result: {
            attempt: prepared.attempt,
            model: config.model,
            reasoningEffort: "high",
            context: "fresh",
            response: reviewResponse(oldPacket, { finding: true, laterReproduction }),
          },
        }),
      ).toMatchObject({ ok: false });
      expect(
        await runProductCritic(await workspace.state(), {
          task: "T001",
          operation: "preflight",
          capabilities,
        }),
      ).toMatchObject({
        ok: true,
        value: { ready: false, gaps: [expect.stringContaining("images")] },
      });

      const replayed = unwrap(
        await runProductCapture(await workspace.state(), { task: "T001", replay: failed.runId }),
      );
      expect(replayed.status).toBe("completed");
      const verified = unwrap(await runProductVerify(await workspace.state(), { task: "T001" }));
      expect(verified.passed).toBe(true);
      expect(verified.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            check: "C002",
            status: "passed",
            captureRunId: expect.any(String),
          }),
        ]),
      );
      expect(unwrap(await runProductNext(await workspace.state(), { task: "T001" }))).toMatchObject(
        {
          action: "refine",
          command: expect.stringContaining("visp review --handoff"),
          completion: "unresolved-product",
        },
      );

      const freshPrepared = unwrap(
        await runProductCritic(await workspace.state(), {
          task: "T001",
          operation: "prepare",
          capabilities,
        }),
      ) as { attempt: string; packetPath: string };
      const freshPacket = JSON.parse(
        await readFile(freshPrepared.packetPath, "utf8"),
      ) as CriticPacket;
      if (laterReproduction)
        expect(freshPacket.current.repairQuestions?.[0]?.reproductions).toEqual([
          expect.objectContaining({
            finding: findingId,
            provenance: "caller-reported",
            command: expect.stringContaining("browser-journey"),
          }),
        ]);
      expect(freshPacket.current.subjectDigest).toBe(afterSubject);
      expect(freshPacket.current.subjectDigest).not.toBe(oldPacket.current.subjectDigest);
      expect(freshPacket.current.images.length).toBeGreaterThan(0);
      const allowedResponseReferences = JSON.stringify(freshPacket.responseSchema);
      for (const run of freshPacket.current.interactionEvidence.runs)
        for (const observation of run.observations)
          expect(allowedResponseReferences).toContain(observation.id);
      expect(freshPacket.current.images.map((image) => image.id)).not.toEqual(
        oldPacket.current.images.map((image) => image.id),
      );
      for (const image of freshPacket.current.images) {
        const imagePath = (image as unknown as { imagePath: string }).imagePath;
        expect(sha256(await readFile(imagePath))).toBe(
          (image as unknown as { sha256: string }).sha256,
        );
      }
      const cleanSubmission = unwrap(
        await runProductCritic(await workspace.state(), {
          task: "T001",
          operation: "submit",
          result: {
            attempt: freshPrepared.attempt,
            model: config.model,
            reasoningEffort: "high",
            context: "fresh",
            outputTokens: 500,
            response: reviewResponse(freshPacket, { resolutionId: findingId }),
          },
        }),
      ) as { action: string; callsUsed: number };
      if (cleanSubmission.action !== "normal-acceptance") {
        const status = await runProductCritic(await workspace.state(), {
          task: "T001",
          operation: "status",
        });
        throw new Error(
          `clean native review remained unresolved: ${JSON.stringify({ cleanSubmission, status })}`,
        );
      }
      expect(cleanSubmission).toMatchObject({ action: "normal-acceptance", callsUsed: 2 });

      expect(unwrap(await runProductDone(await workspace.state(), { task: "T001" }))).toMatchObject(
        {
          passed: true,
          closed: true,
        },
      );
      expect(unwrap(await runProductAccept(await workspace.state())).passed).toBe(true);
    } finally {
      await workspace.destroy();
    }
  },
  60_000,
);
