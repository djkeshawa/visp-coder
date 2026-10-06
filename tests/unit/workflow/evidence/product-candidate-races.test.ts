import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import * as transactions from "../../../../src/core/file-transaction.js";
import {
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import {
  inlineReview,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import { runProductVerify, updateProductBrief } from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
const preset = balancedCritic("codex");
if (!preset) throw new Error("Missing preset");
const config = { ...preset, maxCalls: 2 };
const capabilities = {
  harness: "codex" as const,
  model: config.model,
  reasoningEffort: "high" as const,
  freshContext: true,
  images: true,
  readOnly: true,
  delegationAllowed: true,
};
beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
  await setup.workspace.write("src/large.bin", Buffer.alloc(32 * 1024 * 1024 + 1));
  setup.workspace.commit("existing large source");
  expect(
    await updateProductBrief(await setup.workspace.state(), {
      brief: {
        ...setup.brief,
        slices: [
          {
            ...setup.brief.slices[0],
            scope: { allowed: ["src/**", "test/**"], expected: [], forbidden: [] },
          },
        ],
      },
      reason: "Review declared sources beyond one candidate copy",
    }),
  ).toMatchObject({ ok: true });
  expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
  });
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setup.workspace.destroy();
});

function race(boundary: "planning" | "commit") {
  const apply = transactions.applyFileTransaction;
  let injected = false;
  vi.spyOn(transactions, "applyFileTransaction").mockImplementation(
    async (root, label, mutations, options) => {
      const candidate = mutations.find(
        (mutation) => mutation.kind === "write" && mutation.path.includes("/candidates/"),
      );
      if (injected || !candidate) return apply(root, label, mutations, options);
      injected = true;
      const edit = () => setup.workspace.write("src/value.mjs", "export const value = 3;\n");
      if (boundary === "planning") {
        await edit();
        return apply(root, label, mutations, options);
      }
      return apply(root, label, mutations, {
        ...options,
        async afterMutation(applied) {
          if (applied === mutations.length) await edit();
        },
      });
    },
  );
  return () => expect(injected).toBe(true);
}

it.each(["planning", "commit"] as const)(
  "rejects a checkpoint source race during %s without publishing it",
  async (boundary) => {
    const injected = race(boundary);
    expect(await runProductVerify(await setup.workspace.state(), { task: "T001" })).toMatchObject({
      ok: true,
      value: { checkpoint: { gap: expect.stringContaining("Concurrent change detected") } },
    });
    injected();
    const record = await readProductRecord(await setup.workspace.state());
    expect(record).toMatchObject({ ok: true });
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.checkpoints ?? []).toEqual([]);
  },
);

it.each([
  ["prepare", "planning"],
  ["prepare", "commit"],
  ["native", "planning"],
  ["native", "commit"],
  ["inline-done", "planning"],
  ["inline-done", "commit"],
] as const)(
  "rejects an identity-only %s reservation race during %s without spending a call",
  async (caller, boundary) => {
    expect(await runProductVerify(await setup.workspace.state(), { task: "T001" })).toMatchObject({
      ok: true,
    });
    expect(
      await runProductCritic(await setup.workspace.state(), {
        task: "T001",
        operation: "configure",
        config,
      }),
    ).toMatchObject({ ok: true });
    const injected = race(boundary);
    const host: ProductCriticHost = {
      inspect: async () => capabilities,
      review: vi.fn(async () => {
        throw new Error("A stale candidate must never reach the reviewer");
      }),
    };
    const state = await setup.workspace.state();
    const result =
      caller === "inline-done"
        ? await runProductDoneReviewed(state, { task: "T001" }, inlineReview(host))
        : await runProductCritic(
            state,
            {
              task: "T001",
              operation: caller === "prepare" ? "prepare" : "review",
              ...(caller === "prepare" ? { capabilities } : {}),
            },
            host,
          );
    injected();
    if (caller === "inline-done")
      expect(result).toMatchObject({
        ok: true,
        value: {
          critic: {
            reviewed: false,
            reason: expect.stringContaining("Concurrent change detected"),
          },
        },
      });
    else
      expect(result).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("Concurrent change detected") },
      });
    expect(host.review).not.toHaveBeenCalled();
    expect(
      await runProductCritic(await setup.workspace.state(), { task: "T001", operation: "status" }),
    ).toMatchObject({ ok: true, value: { callsUsed: 0 } });
    expect(await readFile(join(state.paths.root, "src/value.mjs"), "utf8")).toBe(
      "export const value = 3;\n",
    );
  },
);
