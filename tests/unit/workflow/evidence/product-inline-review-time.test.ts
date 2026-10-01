import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import {
  inlineReview,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import {
  type IndependentTester,
  inlineTests,
} from "../../../../src/workflow/product/independent-tests.js";
import { updateProductBrief } from "../../../../src/workflow/product/index.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { legacyReview } from "../../support/legacy-critic.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
function state() {
  if (!workspace) throw new Error("no workspace");
  return workspace.state();
}
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace?.destroy();
  workspace = undefined;
});

const config = { model: "test-critic", maxCalls: 3, timeoutMs: 5000, maxImageBytes: 4194304 };
const host = (): ProductCriticHost => ({
  review: vi.fn(async (packet: CriticPacket) => ({
    model: config.model,
    response: {
      review: {
        ...legacyReview(packet),
        assessments: packet.current.outcomes.map((outcome) => ({
          outcome: outcome.id,
          status: "satisfied",
          summary: "Executed the module and observed the promised value",
          evidence: packet.current.evidence
            .filter((entry) => entry.kind === "execution")
            .slice(0, 1)
            .map((entry) => entry.id),
          expectations: [],
        })),
        feedback: moduleFeedback(packet.current as unknown as ProductReviewBundle),
      },
      comparison: [],
    },
  })),
});

// Fails by name until implemented; once the product carries a `// slow` marker it takes 20 s.
// The tester gate wants three assertion words: assert assert assert.
const SLOW_SUITE = `// assert assert assert
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../../src/value.mjs", import.meta.url), "utf8");
if (source.includes("// slow")) await new Promise((resolve) => setTimeout(resolve, 20000));
console.log("FAIL: value is two: not implemented");
process.exitCode = 1;
`;
const tester: IndependentTester = async () => ({
  file: { name: "value.test.mjs", content: SLOW_SUITE },
  tests: [{ name: "value is two", quote: "Return two" }],
  notes: "",
});

/** T001 is a middle slice (T002 is still open), so its pinned suite only runs for information. */
async function middleSlice(slow = true) {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const raw = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  raw.critic = { ...raw.critic, harness: "codex", mode: "auto", launch: "codex-exec" };
  await workspace.write("visp.yml", stringify(raw));
  workspace.commit("VISP launches the reviewer and tester");
  const first = fixture.brief.slices[0];
  const updated = await updateProductBrief(await workspace.state(), {
    brief: { ...fixture.brief, slices: [...fixture.brief.slices, { ...first, id: "T002" }] },
    reason: "A second slice keeps the first one in the middle",
  });
  expect(updated.ok, JSON.stringify(updated)).toBe(true);
  const work = await runProductWork(await workspace.state(), { task: "T001" }, inlineTests(tester));
  expect(work.ok && work.value.independentTests?.status, JSON.stringify(work)).toBe("pinned");
  expect(
    (
      await runProductCritic(await workspace.state(), {
        task: "T001",
        operation: "configure",
        config,
      })
    ).ok,
  ).toBe(true);
  await workspace.write("src/value.mjs", `export const value = 2;\n${slow ? "// slow\n" : ""}`);
}

it("keeps the review's time when a slow informational pinned suite would eat the call", async () => {
  await middleSlice();
  const reviewer = host();
  const done = await runProductDoneReviewed(
    await state(),
    { task: "T001", deadline: Date.now() + 90_000 },
    inlineReview(reviewer),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  // Without the reservation the 20 s suite left under 75 s and the review was skipped.
  expect(reviewer.review).toHaveBeenCalledTimes(1);
  expect(done.ok && done.value.critic?.reviewed).toBe(true);
}, 60_000);

it("starts an inline review on the MCP channel, whose whole wait is shorter than a review", async () => {
  await middleSlice(false);
  const reviewer = host();
  const done = await runProductDoneReviewed(
    await state(),
    { task: "T001", deadline: Date.now() + 40_000 },
    inlineReview(reviewer),
    50_000,
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(reviewer.review).toHaveBeenCalledTimes(1);
  expect((done.ok && done.value.critic?.reason) ?? "").not.toContain("not started");
}, 60_000);
