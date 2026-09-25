import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { Result } from "../../src/core/result.js";
import { runProductCapture } from "../../src/workflow/evidence/product-capture.js";
import { createProductFeature, updateProductBrief } from "../../src/workflow/product/brief.js";
import { isBrowserCheckCommand } from "../../src/workflow/product/check-command.js";
import { productCaptureRunSchema } from "../../src/workflow/product/evidence-references.js";
import { runProductReview } from "../../src/workflow/product/review.js";
import { runProductNext } from "../../src/workflow/product/status.js";
import { readProductRecord } from "../../src/workflow/product/store.js";
import { runProductWork } from "../../src/workflow/product/work.js";
import { TestWorkspace } from "../unit/support/workspace.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
// Independent terminal-state fixture; this is not the user game or a substitute browser surface for it.
const html = `<!doctype html><meta name="viewport" content="width=device-width"><button id="finish">Finish</button><p id="status">Ready</p><script>document.querySelector('#finish').onclick = function () { this.disabled=true; document.querySelector('#status').textContent='Complete'; };</script>`;
it("resolves a mistaken post-completion wait through actual runner observations and mobile touch input", async () => {
  const workspace = await TestWorkspace.create({ "index.html": html });
  try {
    await workspace.installFoundation();
    workspace.commit("foundation");
    const started = value(
      await createProductFeature(await workspace.state(), {
        goal: "Build a browser UI with visible completion",
      }),
    );
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...started.brief,
          outcomes: [
            { id: "O001", kind: "experience", statement: "Finishing shows the completed state" },
          ],
          slices: [
            {
              id: "T001",
              goal: "Finish the interaction",
              outcomes: ["O001"],
              scope: { allowed: ["index.html"] },
            },
          ],
        },
      }),
    );
    // No authored browser check exists yet: work still tests startup/capture capability.
    value(await runProductWork(await workspace.state()));
    const url = pathToFileURL(join(workspace.root, "index.html")).href;
    const viewport = { width: 390, height: 844 };
    const first = value(
      await runProductCapture(await workspace.state(), {
        journey: {
          url,
          viewport,
          actions: [
            { kind: "click", selector: "#finish" },
            { kind: "wait-for", selector: "#finish", enabled: true, timeoutMs: 200 },
          ],
        },
      }),
    );
    expect(first.status).toBe("timed-out");
    expect(value(await runProductNext(await workspace.state())).action).toBe("fix");
    const second = value(
      await runProductCapture(await workspace.state(), {
        journey: {
          url,
          viewport,
          actions: [
            { kind: "tap", selector: "#finish" },
            { kind: "wait-for", selector: "#status", text: "Complete", timeoutMs: 500 },
          ],
        },
      }),
    );
    expect(second.status).toBe("completed");
    const record = value(await readProductRecord(await workspace.state()));
    const run = productCaptureRunSchema.parse(record.state.captureRuns.at(-1));
    const observed = run.operations.findLast((entry) => entry.kind === "observe");
    const capture = run.captures.at(-1);
    if (!observed || !capture) throw new Error("Missing executed observation or image");
    expect(run.operations.some((entry) => entry.kind === "touch")).toBe(true);
    const bundle = value(await runProductReview(await workspace.state()));
    const reviewed = value(
      await runProductReview(await workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [],
        reviewer: { context: "current" },
        experimentResolutions: [
          {
            runId: first.runId,
            replacementRunId: second.runId,
            outcome: "O001",
            reason:
              "The exploratory wait expected another action after terminal completion. The retained outcome requires visible completion, which the replacement observes after touch input.",
            evidence: [observed.id, capture.id],
          },
        ],
      }),
    );
    expect(reviewed.experiments.failures).toEqual([]);
    expect(reviewed.gaps.join("\n")).not.toContain("Browser timed-out");
    expect(value(await readProductRecord(await workspace.state())).state.captureRuns).toEqual(
      record.state.captureRuns,
    );
    expect(value(await runProductNext(await workspace.state())).action).toBe("refine");
  } finally {
    await workspace.destroy();
  }
}, 30_000);

it("keeps a failed pointer control unresolved when keyboard completion succeeds", async () => {
  const workspace = await TestWorkspace.create({
    "index.html":
      '<button id="finish" disabled>Finish</button><p id="status">Ready</p><script>document.onkeydown=()=>document.querySelector("#status").textContent="Complete"</script>',
  });
  try {
    await workspace.installFoundation();
    workspace.commit("foundation");
    const started = value(
      await createProductFeature(await workspace.state(), {
        goal: "Finish by pointer or keyboard in a browser UI",
      }),
    );
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...started.brief,
          outcomes: [
            {
              id: "O001",
              kind: "experience",
              statement: "Both pointer and keyboard completion work",
            },
          ],
          slices: [
            {
              id: "T001",
              goal: "Complete",
              outcomes: ["O001"],
              scope: { allowed: ["index.html"] },
            },
          ],
        },
      }),
    );
    value(await runProductWork(await workspace.state()));
    const url = pathToFileURL(join(workspace.root, "index.html")).href;
    const failed = value(
      await runProductCapture(await workspace.state(), {
        journey: { url, actions: [{ kind: "click", selector: "#finish" }] },
      }),
    );
    const passed = value(
      await runProductCapture(await workspace.state(), {
        journey: {
          url,
          actions: [
            { kind: "key", key: "Enter" },
            { kind: "wait-for", selector: "#status", text: "Complete", timeoutMs: 500 },
          ],
        },
      }),
    );
    expect(failed.status).not.toBe("completed");
    expect(passed.status).toBe("completed");
    const record = value(await readProductRecord(await workspace.state()));
    const runs = record.state.captureRuns.map((run) => productCaptureRunSchema.parse(run));
    expect(runs[0]?.failure?.input).toEqual({ kind: "click", selector: "#finish" });
    const replacement = runs.at(-1);
    const observed = replacement?.operations.findLast((operation) => operation.kind === "observe");
    const image = replacement?.captures.at(-1);
    const bundle = value(await runProductReview(await workspace.state()));
    expect(
      await runProductReview(await workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [],
        experimentResolutions: [
          {
            runId: failed.runId,
            replacementRunId: passed.runId,
            outcome: "O001",
            reason: "Keyboard reaches the same final state",
            evidence: [observed?.id, image?.id],
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("bypasses the failed input") },
    });
  } finally {
    await workspace.destroy();
  }
}, 30_000);

it("reconciles a corrected declared text assertion without changing the outcome or product", async () => {
  const { runProductVerify } = await import("../../src/workflow/product/index.js");
  const { runProductReviewRequest } = await import("../../src/workflow/product/review-request.js");
  const workspace = await TestWorkspace.create({
    "index.html": html.replace("textContent='Complete'", "textContent='Complete · saved'"),
  });
  try {
    await workspace.installFoundation();
    workspace.commit("foundation");
    const started = value(
      await createProductFeature(await workspace.state(), {
        goal: "Finish with visible confirmation in a browser",
      }),
    );
    const url = pathToFileURL(join(workspace.root, "index.html")).href;
    const authored = value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...started.brief,
          outcomes: [{ id: "O001", kind: "experience", statement: "Finishing shows confirmation" }],
          checks: [
            {
              id: "C001",
              outcomes: ["O001"],
              files: ["index.html"],
              command: {
                kind: "browser-journey",
                journey: {
                  url,
                  actions: [
                    { kind: "click", selector: "#finish" },
                    {
                      kind: "wait-for",
                      selector: "#status",
                      text: "Complete",
                      timeoutMs: 200,
                      capture: true,
                    },
                  ],
                },
              },
            },
          ],
          slices: [
            {
              id: "T001",
              goal: "Finish the interaction",
              outcomes: ["O001"],
              checks: ["C001"],
              scope: { allowed: ["index.html"] },
            },
          ],
        },
        reason: "Define visible confirmation",
      }),
    );
    value(await runProductWork(await workspace.state()));
    expect(value(await runProductVerify(await workspace.state())).passed).toBe(false);
    const before = value(await readProductRecord(await workspace.state()));
    const originalFailure = before.state.captureRuns[0];
    const revised = structuredClone(authored);
    const check = revised.checks[0];
    if (!check || !isBrowserCheckCommand(check.command)) throw new Error("Missing browser check");
    check.command.journey.actions[1] = {
      kind: "wait-for",
      selector: "#status",
      text: "Complete · saved",
      timeoutMs: 500,
      capture: true,
    };
    value(
      await updateProductBrief(await workspace.state(), {
        brief: revised,
        reason:
          "Correct the exact-text assertion to the observed confirmation; keep the user outcome",
      }),
    );
    value(await runProductWork(await workspace.state()));
    value(await runProductVerify(await workspace.state()));
    const prepared = value(
      await runProductReviewRequest(await workspace.state(), { prepare: true, task: "T001" }),
    ) as {
      session: string;
      recovery: {
        submission: {
          assessments: [];
          reviewer: { context: string };
          experimentResolutions: { reason: string }[];
        };
      }[];
    };
    const suggestion = prepared.recovery[0]?.submission;
    if (!suggestion?.experimentResolutions[0])
      throw new Error("No recovery for the corrected declared assertion");
    suggestion.reviewer.context = "current";
    suggestion.experimentResolutions[0].reason =
      "The failed wait omitted the suffix in the actual confirmation. The rerun of C001 observes the same Finish click and its confirmation; the required outcome is unchanged.";
    expect(
      await runProductReviewRequest(await workspace.state(), {
        task: "T001",
        session: prepared.session,
        ...suggestion,
      }),
    ).toMatchObject({ ok: true, value: { recorded: true } });
    const after = value(await readProductRecord(await workspace.state()));
    expect(after.state.outcomeDigest).toBe(before.state.outcomeDigest);
    expect(after.state.captureRuns[0]).toEqual(originalFailure);
    expect(value(await runProductReview(await workspace.state())).experiments.failures).toEqual([]);
  } finally {
    await workspace.destroy();
  }
}, 30_000);
