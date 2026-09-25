import { afterEach, expect, it, vi } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import * as probe from "../../../../src/testing/browser-capability.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { needsBrowser } from "../../../../src/workflow/product/environment.js";
import { runProductDone, runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { currentFailedJourneys } from "../../../../src/workflow/product/evidence-references.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import {
  productReviewSubmissionSchema,
  runProductReviewRequest,
} from "../../../../src/workflow/product/review-request.js";
import { runProductNext } from "../../../../src/workflow/product/status.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { reviewInputTemplate } from "../../../../src/workflow/product-inputs.js";
import { recordedProductJourney } from "../../support/product-journey.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});
function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
async function fixture() {
  const p = await productWorkspace();
  projects.push(p);
  value(await runProductWork(await p.workspace.state()));
  await p.workspace.write("src/value.mjs", "export const value=2;\n");
  value(await runProductVerify(await p.workspace.state()));
  return p;
}
async function journeys() {
  const p = await fixture();
  await recordedProductJourney(p.workspace, "wrong-wait");
  const captures = await recordedProductJourney(p.workspace, "observed-win");
  const state = await p.workspace.state(),
    record = value(await readProductRecord(state));
  const contractDigest = productContractDigest(record.brief, record.brief.slices[0]);
  const runs = record.state.captureRuns.map((run, i) => ({
    ...(run as object),
    id: i ? "win" : "wait",
    version: 2,
    task: "T001",
    contractDigest,
    journeyKey: `journey-v2:${i}`,
    status: i ? "completed" : "timed-out",
    ...(i
      ? {}
      : {
          failure: { kind: "behavior", message: "Quick Shot never enabled after terminal victory" },
        }),
  }));
  const second = runs[1] as (typeof runs)[number] & { operations: unknown[] };
  second.operations.push({
    id: "win-observation",
    kind: "observe",
    measurement: { json: '{"matched":true,"text":"Flock yeah!"}', truncated: false },
  });
  value(await saveProductState(state, record, { ...record.state, captureRuns: runs }));
  const resolution = {
    runId: "wait",
    replacementRunId: "win",
    outcome: "O001",
    reason:
      "The experiment incorrectly expected a launch control after terminal victory. The preserved goal requires a win state; the replacement observes that state.",
    evidence: ["win-observation", captures[1]?.id ?? "missing"],
  };
  const bundle = value(await runProductReview(await p.workspace.state()));
  return { ...p, resolution, bundle, captures };
}

it("routes an ad hoc failed wait to focused review rather than another done loop", async () => {
  const p = await journeys();
  expect(value(await runProductDone(await p.workspace.state())).closed).toBe(false);
  expect(value(await runProductNext(await p.workspace.state()))).toMatchObject({
    action: "fix",
    completion: "unresolved-product",
  });
  expect(value(await runProductNext(await p.workspace.state())).command).toContain(
    "review --handoff",
  );
});

it("resolves an erroneous experiment with executed replacement observations without changing raw history or outcomes", async () => {
  const p = await journeys(),
    state = await p.workspace.state();
  const before = value(await readProductRecord(state));
  const submitted = value(
    await runProductReview(state, {
      subjectDigest: p.bundle.subjectDigest,
      assessments: [],
      reviewer: { context: "current" },
      experimentResolutions: [p.resolution],
    }),
  );
  expect(submitted.gaps.join("\n")).not.toContain("Quick Shot never enabled");
  const after = value(await readProductRecord(await p.workspace.state()));
  expect(after.brief).toEqual(before.brief);
  expect(after.state.captureRuns).toEqual(before.state.captureRuns);
  expect(currentFailedJourneys(after, p.bundle.subjectDigest)).toEqual([]);
  expect(after.state.reviews.at(-1)?.experimentResolutions?.[0]?.reason).toContain(
    "incorrectly expected",
  );
  // Raw observation bytes remain required after the review is saved.
  await p.workspace.write(p.captures[1]?.path ?? "missing", "corrupt");
  expect(value(await runProductDone(await p.workspace.state())).gaps.join("\n")).toContain(
    "Experiment wait",
  );
});

it.each(["missing", "failed", "stale", "task", "declared", "fabricated", "unavailable", "outcome"])(
  "rejects %s experiment resolutions",
  async (kind) => {
    const p = await journeys(),
      state = await p.workspace.state();
    const record = value(await readProductRecord(state));
    if (["failed", "stale", "task"].includes(kind)) {
      const runs = record.state.captureRuns.map((entry, i) =>
        i
          ? {
              ...(entry as object),
              ...{
                failed: { status: "failed" },
                stale: { subjectDigest: "old" },
                task: { task: "T999" },
              }[kind],
            }
          : entry,
      );
      value(await saveProductState(state, record, { ...record.state, captureRuns: runs }));
    }
    if (kind === "declared")
      value(
        await saveProductState(state, record, {
          ...record.state,
          executions: record.state.executions.map((entry) => ({ ...entry, captureRunId: "wait" })),
        }),
      );
    const resolution = {
      ...p.resolution,
      ...(kind === "missing" ? { replacementRunId: "invented" } : {}),
      ...(kind === "fabricated" ? { evidence: ["true", "passed"] } : {}),
      ...(kind === "outcome" ? { outcome: "O999" } : {}),
    };
    expect(
      await runProductReview(await p.workspace.state(), {
        subjectDigest: p.bundle.subjectDigest,
        assessments: [],
        reviewer: {
          context: kind === "unavailable" ? "unavailable" : "current",
          reason: "Review capability",
        },
        experimentResolutions: [resolution],
      }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
  },
);

it("keeps explicitly reported code defects visible even when outcome checks pass", async () => {
  const p = await fixture();
  const bundle = value(await runProductReview(await p.workspace.state()));
  value(
    await runProductReview(await p.workspace.state(), {
      subjectDigest: bundle.subjectDigest,
      assessments: [
        { outcome: "O001", status: "satisfied", summary: "Value is two", evidence: ["C001"] },
      ],
      feedback: {
        phase: "product",
        dimensions: [
          {
            dimension: "code",
            status: "failed",
            reason: "Two handlers mutate the same round state inconsistently",
            evidence: [],
          },
        ],
      },
    }),
  );
  const next = value(await runProductNext(await p.workspace.state()));
  expect(next.action).toBe("fix");
  expect(next.evidence.join("\n")).toContain("Two handlers mutate");
  expect(next.command).not.toContain("visp done");
});

it("round-trips selected review images despite newer captures and rejects stale contexts", async () => {
  const p = await fixture();
  const retained = await recordedProductJourney(p.workspace, "selected");
  const bundle = value(await runProductReview(await p.workspace.state()));
  const template = productReviewSubmissionSchema.parse(reviewInputTemplate(bundle));
  for (let i = 0; i < 4; i++) await recordedProductJourney(p.workspace, `later-${i}`);
  const reviewed = value(
    await runProductReview(await p.workspace.state(), {
      ...template,
      feedback: undefined,
      coverage: [],
    }),
  );
  expect(reviewed.images.slice(0, 2).map((image) => image.id)).toEqual(
    retained.map((image) => image.id),
  );
  await p.workspace.write("src/value.mjs", "export const value=3;\n");
  expect(await runProductReviewRequest(await p.workspace.state(), template)).toMatchObject({
    ok: false,
    error: { code: "EVIDENCE_FAILED" },
  });
});

it("includes images cited only by dimension feedback in bounded delivery", async () => {
  const p = await fixture();
  const retained = await recordedProductJourney(p.workspace, "feedback-only");
  for (let i = 0; i < 4; i++) await recordedProductJourney(p.workspace, `other-${i}`);
  const bundle = value(await runProductReview(await p.workspace.state()));
  expect(bundle.images.some((entry) => entry.id === retained[0]?.id)).toBe(false);
  const reviewed = value(
    await runProductReview(await p.workspace.state(), {
      subjectDigest: bundle.subjectDigest,
      assessments: [],
      reviewer: { context: "current" },
      feedback: {
        phase: "product",
        dimensions: [
          {
            dimension: "experience",
            status: "unclear",
            reason: "Primary touch target still needs observation",
            evidence: retained.map((entry) => entry.id),
          },
        ],
      },
    }),
  );
  expect(reviewed.images.slice(0, 2).map((entry) => entry.id)).toEqual(
    retained.map((entry) => entry.id),
  );
  expect(
    reviewed.interactionEvidence.runs
      .flatMap((run) => run.inputs)
      .every((entry) => entry.kind === "pointer"),
  ).toBe(true);
  expect(reviewed.interactionEvidence.guidance).toContain("not touch execution");
});

it("probes promised browser UI before checks exist without imposing Chrome on native or CLI slices", async () => {
  const p = await productWorkspace();
  projects.push(p);
  const brief = value(
    await updateProductBrief(await p.workspace.state(), {
      brief: {
        ...p.brief,
        goal: "Build a browser game",
        outcomes: [
          {
            ...p.brief.outcomes[0],
            id: "O001",
            kind: "experience",
            statement: "A usable play area",
          },
        ],
        checks: [],
        slices: p.brief.slices.map((s) => ({ ...s, checks: [] })),
      },
      reason: "Describe the first browser slice",
      intentChange: { reason: "Clarify requested surface", provenance: "agent-reported" },
    } as Parameters<typeof updateProductBrief>[1]),
  );
  expect(needsBrowser(brief, brief.slices[0])).toBe(true);
  expect(
    needsBrowser(
      { ...brief, originalRequest: "Native desktop app", goal: "Native controls" },
      brief.slices[0],
    ),
  ).toBe(false);
  const launch = vi
    .spyOn(probe, "probeBrowserCapability")
    .mockRejectedValue(new Error("Chrome missing"));
  expect(await runProductWork(await p.workspace.state())).toMatchObject({ ok: true });
  expect(await runProductNext(await p.workspace.state())).toMatchObject({
    ok: true,
    value: { mayEdit: true },
  });
  expect(launch).toHaveBeenCalledOnce();
});
