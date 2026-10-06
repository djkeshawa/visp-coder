import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { balancedCritic } from "../../../../src/config/critic.js";
import type { Result } from "../../../../src/core/result.js";
import { productEvidenceGaps } from "../../../../src/workflow/product/assessment.js";
import { reviewChangedPaths } from "../../../../src/workflow/product/code-context.js";
import { type CriticPacket, runProductCritic } from "../../../../src/workflow/product/critic.js";
import {
  inlineReview,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import { productEvidenceCatalogue } from "../../../../src/workflow/product/evidence-references.js";
import type { IndependentReview } from "../../../../src/workflow/product/independent-review.js";
import {
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review-request.js";
import {
  productScopes,
  readProductAuthorization,
  readProductAuthorizationBaseline,
} from "../../../../src/workflow/product/scopes.js";
import { authorizationPath, readProductRecord } from "../../../../src/workflow/product/store.js";
import {
  productSourceDigest,
  productSourceSnapshot,
} from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function present<T>(entry: T | undefined): T {
  if (entry === undefined) throw new Error("Expected an entry");
  return entry;
}
const config = { ...present(balancedCritic("codex")), maxCalls: 2 };
const capabilities = {
  harness: "codex" as const,
  model: config.model,
  reasoningEffort: config.reasoningEffort,
  freshContext: true,
  images: true,
  readOnly: true,
  delegationAllowed: true,
};
function response(current: CriticPacket["current"]): IndependentReview {
  const diff = current.sources.find((source) => source.kind === "implementation-diff");
  expect(diff).toBeDefined();
  const execution = current.evidence.find(
    (entry) => entry.kind === "execution" && entry.status === "available",
  );
  expect(execution).toBeDefined();
  return {
    summary: "Inspected the diff and passing assertion",
    assessments: [
      {
        outcome: "O001",
        status: "satisfied",
        summary: "Executed assertion and reviewed change",
        evidence: [present(diff).id, present(execution).id],
        expectations: [],
      },
    ],
    findings: [],
    limitations: [],
    resolutions: [],
    disputes: [],
  };
}
async function setup(required = true, launched = false, followup = true) {
  const p = await productWorkspace({ critic: true });
  projects.push(p);
  const w = p.workspace;
  if (launched) {
    const raw = parse(await readFile(join(w.root, "visp.yml"), "utf8"));
    raw.critic = { ...raw.critic, ...config, mode: "auto", launch: "codex-exec" };
    await w.write("visp.yml", stringify(raw));
    w.commit("configure launched reviewer");
  }
  value(
    await updateProductBrief(await w.state(), {
      brief: {
        ...p.brief,
        outcomes: p.brief.outcomes.map((outcome) => ({ ...outcome, reviewRequired: required })),
        slices: followup
          ? [p.brief.slices[0], { ...p.brief.slices[0], id: "T002" }]
          : [p.brief.slices[0]],
      },
      reason: "Exercise diff evidence across later authorization",
      intentChange: { reason: "Require review when selected", provenance: "test fixture" },
    }),
  );
  if (launched)
    value(
      await runProductCritic(await w.state(), {
        operation: "set-policy",
        enabled: true,
        harness: "codex",
      }),
    );
  value(await runProductWork(await w.state(), { task: "T001" }));
  await w.write("src/value.mjs", "export const value = 2;\n");
  return w;
}
it.each(["session", "native", "attached", "inline"])(
  "%s diff citation closes the slice and survives closure and later authorization",
  async (mode) => {
    const w = await setup();
    const state = await w.state();
    value(await runProductVerify(state, { task: "T001" }));
    if (mode === "session") {
      const prepared = value(
        await runProductReviewRequest(state, { prepare: true, task: "T001" }),
      ) as { packetPath: string; session: string };
      const current = JSON.parse(await readFile(prepared.packetPath, "utf8"));
      value(
        await runProductReviewRequest(state, {
          session: prepared.session,
          assessments: response(current).assessments,
          reviewer: { context: "fresh" },
        }),
      );
    } else {
      value(await runProductCritic(state, { task: "T001", operation: "configure", config }));
      const host = {
        inspect: async () => capabilities,
        review: async (packet: CriticPacket) => ({
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          context: "fresh" as const,
          response: response(packet.current),
        }),
      };
      if (mode === "native") {
        const prepared = value(
          await runProductCritic(state, { task: "T001", operation: "prepare", capabilities }),
        ) as { packetPath: string; attempt: string };
        const packet = JSON.parse(await readFile(prepared.packetPath, "utf8"));
        value(
          await runProductCritic(state, {
            task: "T001",
            operation: "submit",
            attempt: prepared.attempt,
            response: response(packet.current),
            capabilities,
          }),
        );
      } else if (mode === "attached") {
        value(await runProductCritic(state, { task: "T001", operation: "review" }, host));
      } else {
        expect(
          await runProductDoneReviewed(state, { task: "T001" }, inlineReview(host)),
        ).toMatchObject({ ok: true, value: { closed: true, critic: { reviewed: true } } });
      }
    }
    let record = value(await readProductRecord(state));
    const subject = value(await productSourceDigest(state));
    expect(await productEvidenceGaps(state, record, subject, record.brief.slices[0])).toEqual([]);
    expect(await runProductDone(state, { task: "T001" })).toMatchObject({
      ok: true,
      value: { closed: true },
    });
    record = value(await readProductRecord(state));
    expect(await productEvidenceGaps(state, record, subject, record.brief.slices[0])).toEqual([]);
    value(await runProductWork(state, { task: "T002" }));
    record = value(await readProductRecord(state));
    const exec = await import("../../../../src/core/exec.js");
    const calls = vi.spyOn(exec, "run");
    expect(await productEvidenceGaps(state, record, subject, record.brief.slices[0])).toEqual([]);
    expect(
      calls.mock.calls.filter(([command, args]) => command === "git" && args.includes("diff")),
    ).toHaveLength(0);
    const catalogue = await productEvidenceCatalogue(
      state,
      record,
      subject,
      [],
      [],
      undefined,
      record.brief.slices[0],
    );
    expect(catalogue.entries.some((entry) => entry.id === "CODE-DIFF-forged")).toBe(false);
    const other = await productEvidenceCatalogue(
      state,
      record,
      subject,
      [],
      [],
      undefined,
      record.brief.slices[1],
    );
    for (const id of present(present(record.state.reviews.at(-1)).assessments[0]).evidence.filter(
      (id) => id.startsWith("CODE-DIFF-"),
    ))
      expect(other.entries.find((entry) => entry.id === id)?.status).not.toBe("available");
    await w.write("src/value.mjs", "export const value = 3;\n");
    const changed = value(await productSourceDigest(state));
    const stale = await productEvidenceCatalogue(
      state,
      record,
      changed,
      [],
      [],
      undefined,
      record.brief.slices[0],
    );
    for (const id of present(present(record.state.reviews.at(-1)).assessments[0]).evidence.filter(
      (id) => id.startsWith("CODE-DIFF-"),
    ))
      expect(stale.entries.find((entry) => entry.id === id)?.status).not.toBe("available");
  },
);
it("closed-slice and whole-feature packets retain the baseline diff and changed paths", async () => {
  const w = await setup(false, false, false);
  const state = await w.state();
  expect(await runProductDone(state, { task: "T001" })).toMatchObject({
    ok: true,
    value: { closed: true },
  });
  const record = value(await readProductRecord(state));
  expect(
    value(await state.files.readTextIfExists(authorizationPath(state, record.brief.feature))),
  ).toBeUndefined();
  expect(value(await readProductAuthorizationBaseline(state, record))?.task).toBe("T001");
  expect(value(await readProductAuthorization(state, record))).toBeUndefined();
  // Even a pending owner cannot obtain editing authority from the read-only copy.
  const pending = {
    ...record,
    state: {
      ...record.state,
      slices: {
        ...record.state.slices,
        T001: { ...present(record.state.slices.T001), status: "pending" as const },
      },
    },
  };
  expect(value(await readProductAuthorization(state, pending))).toBeUndefined();
  expect(value(await productScopes(state))).toEqual([]);
  const snapshot = value(await productSourceSnapshot(state, record.brief));
  for (const slice of [record.brief.slices[0], undefined]) {
    expect(value(await reviewChangedPaths(state, record, snapshot, slice))).toEqual(
      new Set(["src/value.mjs"]),
    );
    const packet = value(await runProductReview(state, { task: slice?.id }));
    expect(packet.selection.task).toBe(slice?.id);
    expect(
      packet.sources.find((source) => source.kind === "implementation-diff")?.excerpt,
    ).toContain("+export const value = 2;");
  }
});
it("post-closure inline completing review receives the changed diff", async () => {
  const w = await setup(false, true);
  const state = await w.state();
  value(await runProductDone(state, { task: "T001" }));
  value(await runProductWork(state, { task: "T002" }));
  await w.write("src/value.mjs", "export const value = 2; // completing change\n");
  value(await runProductCritic(await w.state(), { operation: "configure", config }));
  const review = vi.fn(async (packet: CriticPacket) => {
    expect(packet.selection.task).toBeUndefined();
    expect(present(value(await readProductRecord(state)).state.slices.T002).status).toBe("closed");
    return {
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      context: "fresh" as const,
      response: response(packet.current),
    };
  });
  const done = await runProductDoneReviewed(
    await w.state(),
    { task: "T002" },
    inlineReview({ inspect: async () => capabilities, review }),
  );
  expect(done, JSON.stringify(done)).toMatchObject({
    ok: true,
    value: { closed: true, critic: { reviewed: true } },
  });
  expect(review).toHaveBeenCalledTimes(1);
});
