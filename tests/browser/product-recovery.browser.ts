import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { Result } from "../../src/core/result.js";
import { runProductCapture } from "../../src/workflow/evidence/product-capture.js";
import { currentFailedJourneys } from "../../src/workflow/product/evidence-references.js";
import type { ExperimentResolution } from "../../src/workflow/product/experiment-model.js";
import { createProductFeature, updateProductBrief } from "../../src/workflow/product/index.js";
import { runProductReviewRequest } from "../../src/workflow/product/review-request.js";
import { readProductRecord } from "../../src/workflow/product/store.js";
import { TestWorkspace } from "../unit/support/workspace.js";

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

it("offers and validates recorded counterevidence for an off-screen click without clearing raw failures or requiring product edits", async () => {
  const workspace = await TestWorkspace.create();
  try {
    await workspace.write(
      "index.html",
      '<!doctype html><div style="height:1800px">Scroll to action</div><button id="save" onclick="document.querySelector(\'#result\').textContent=\'Saved\'">Save</button><output id="result"></output>',
    );
    await workspace.installFoundation();
    workspace.commit("Install local Save fixture");
    const started = value(
      await createProductFeature(await workspace.state(), {
        goal: "Show Saved after activating the visible Save control",
      }),
    );
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...started.brief,
          outcomes: [
            {
              id: "O001",
              kind: "functional",
              statement: "Activating Save shows Saved",
              provenance: "user-stated",
            },
          ],
          slices: [
            {
              id: "T001",
              goal: "Show the save result",
              outcomes: ["O001"],
              scope: { allowed: ["index.html"] },
            },
          ],
        },
        reason: "Define the observed save interaction",
      }),
    );
    const state = await workspace.state();
    const journey = {
      url: pathToFileURL(join(workspace.root, "index.html")).href,
      viewport: { width: 390, height: 844 },
    };
    const failed = value(
      await runProductCapture(state, {
        task: "T001",
        journey: { ...journey, actions: [{ kind: "click", selector: "#save" }] },
      }),
    );
    expect(failed.status).toBe("failed");
    const recovered = value(
      await runProductCapture(state, {
        task: "T001",
        journey: {
          ...journey,
          actions: [
            { kind: "scroll", selector: "#save" },
            { kind: "click", selector: "#save" },
            { kind: "wait-for", selector: "#result", text: "Saved", capture: true },
          ],
        },
      }),
    );
    expect(recovered.status).toBe("completed");
    const before = value(await readProductRecord(state));
    const bytes = await Promise.all(
      [...failed.captures, ...recovered.captures].map((c) =>
        readFile(join(workspace.root, c.path)),
      ),
    );
    const session = value(
      await runProductReviewRequest(state, { task: "T001", prepare: true }),
    ) as {
      session: string;
      packetPath: string;
      recovery: {
        submission: {
          assessments: never[];
          reviewer: { context: "unspecified" | "current" };
          experimentResolutions: ExperimentResolution[];
        };
      }[];
    };
    expect(session.recovery).toHaveLength(1);
    const draft = session.recovery[0]?.submission;
    if (!draft?.experimentResolutions[0]) throw new Error("Missing recovery draft");
    expect(draft.experimentResolutions[0]).toMatchObject({
      runId: failed.runId,
      replacementRunId: recovered.runId,
      reason: "",
    });
    // The critic remains independent: procedural recovery is delivered to the host only.
    const packet = JSON.parse(await readFile(session.packetPath, "utf8"));
    expect(packet).not.toHaveProperty("recovery");
    expect(
      await runProductReviewRequest(state, { task: "T001", session: session.session, ...draft }),
    ).toMatchObject({ ok: false });
    expect(
      currentFailedJourneys(
        value(await readProductRecord(state)),
        recovered.captures[0]?.subjectDigest ?? "",
      ),
    ).toHaveLength(1);
    draft.experimentResolutions[0].reason =
      "The exploratory click omitted scrolling. The same pointer control works after scrolling at the same viewport, and the observed result is Saved; no product change was needed.";
    expect(
      await runProductReviewRequest(state, { task: "T001", session: session.session, ...draft }),
    ).toMatchObject({ ok: false });
    draft.reviewer.context = "current";
    value(
      await runProductReviewRequest(state, { task: "T001", session: session.session, ...draft }),
    );
    const after = value(await readProductRecord(state));
    expect(after.state.captureRuns).toEqual(before.state.captureRuns);
    expect(after.brief).toEqual(before.brief);
    expect(currentFailedJourneys(after, recovered.captures[0]?.subjectDigest ?? "")).toHaveLength(
      0,
    );
    expect(
      await Promise.all(
        [...failed.captures, ...recovered.captures].map((c) =>
          readFile(join(workspace.root, c.path)),
        ),
      ),
    ).toEqual(bytes);
    expect(after.state.reviews.at(-1)?.assessments).toEqual([]);
  } finally {
    await workspace.destroy();
  }
});
