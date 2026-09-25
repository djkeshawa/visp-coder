import { readFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import { criticPacket } from "../../../../src/workflow/product/critic-packet.js";
import { criticSelection, readCriticState } from "../../../../src/workflow/product/critic-store.js";
import { independentReviewTemplate } from "../../../../src/workflow/product/independent-review.js";
import { runProductVerify, runProductWork } from "../../../../src/workflow/product/index.js";
import { OBSERVATION_REVIEW_INSTRUCTIONS } from "../../../../src/workflow/product/observation-preview.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review-request.js";
import { runProductReviewerHandoff } from "../../../../src/workflow/product/reviewer-handoff.js";
import { recordedProductJourney } from "../../support/product-journey.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.workspace.destroy();
});

async function ready(images: boolean) {
  const project = await productWorkspace({ critic: true });
  projects.push(project);
  const w = project.workspace;
  expect((await runProductWork(await w.state())).ok).toBe(true);
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(await w.state())).ok).toBe(true);
  expect(
    (
      await runProductCritic(await w.state(), {
        operation: "configure",
        task: "T001",
        config: balancedCritic("codex"),
      })
    ).ok,
  ).toBe(true);
  if (images) await recordedProductJourney(w, "review-images");
  return w.state();
}

it.each(["current", "observation-preview"] as const)(
  "delivers the same product rubric through native, prepared and host review in %s mode",
  async (reviewMode) => {
    const workspace = await ready(true);
    workspace.config.workflow.reviewMode = reviewMode;
    const handoff = await runProductReviewerHandoff(workspace, { task: "T001" });
    const selected = await criticSelection(workspace, { task: "T001" });
    if (!handoff.ok || !selected.ok) throw new Error("Missing review setup");
    const state = await readCriticState(workspace, selected.value);
    if (!state.ok || !state.value.state) throw new Error("Missing critic state");
    const native = await criticPacket(workspace, selected.value, state.value.state, handoff.value);
    if (!native.ok) throw new Error(native.error.message);
    const prepared = await runProductReviewRequest(workspace, { task: "T001", prepare: true });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const packet = JSON.parse(
      await readFile((prepared.value as { packetPath: string }).packetPath, "utf8"),
    );
    let delivered: unknown;
    await runProductReviewRequest(
      workspace,
      { task: "T001", dispatch: true },
      {
        model: "test-reviewer",
        review: async (request) => {
          delivered = request;
          return independentReviewTemplate();
        },
      },
    );
    expect(packet.instructions).toBe(native.value.instructions);
    expect(delivered).toMatchObject({ instructions: native.value.instructions });
    expect(packet.instructions).toContain("visual quality");
    expect(packet.instructions).toContain("composition");
    expect(packet.instructions.includes(OBSERVATION_REVIEW_INSTRUCTIONS)).toBe(
      reviewMode === "observation-preview",
    );
    expect(packet.images.length).toBeGreaterThan(0);
    for (const input of [packet, delivered, native.value.current]) {
      for (const key of ["feedbackPlan", "agenda", "previousFindings", "challenges"])
        expect(input).not.toHaveProperty(key);
    }
    expect(native.value.current).not.toHaveProperty("instructions");
  },
);

it("does not give source-only or design consultations rendered-product instructions", async () => {
  const workspace = await ready(true);
  const handoff = await runProductReviewerHandoff(workspace, { task: "T001" });
  if (!handoff.ok) throw new Error(handoff.error.message);
  for (const phase of ["product", "understanding"] as const) {
    const selected = await criticSelection(workspace, { task: "T001", phase });
    if (!selected.ok) throw new Error(selected.error.message);
    const state = await readCriticState(workspace, selected.value);
    if (!state.ok || !state.value.state) throw new Error("Missing critic state");
    const packet = await criticPacket(
      workspace,
      selected.value,
      state.value.state,
      handoff.value,
      undefined,
      phase === "product",
    );
    if (!packet.ok) throw new Error(packet.error.message);
    expect(packet.value.instructions).not.toContain("visual quality");
    expect(packet.value.instructions).toContain("assessments:[]");
    expect(packet.value.instructions).toContain("resolutions:[]");
    expect(packet.value.current).not.toHaveProperty("instructions");
    if (phase === "product") expect(packet.value.current.images).toEqual([]);
  }
});

it("keeps UI-specific advice out of a nonvisual module review", async () => {
  const workspace = await ready(false);
  const prepared = await runProductReviewRequest(workspace, { task: "T001", prepare: true });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const packet = JSON.parse(
    await readFile((prepared.value as { packetPath: string }).packetPath, "utf8"),
  );
  expect(packet.instructions).toEqual(expect.any(String));
  expect(packet.instructions).not.toContain("visual quality");
});
