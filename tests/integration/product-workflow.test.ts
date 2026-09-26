import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as transactions from "../../src/core/file-transaction.js";
import { sha256 } from "../../src/core/hash.js";
import type { Result } from "../../src/core/result.js";
import {
  createProductFeature,
  parseProductBrief,
  productScopes,
  readProductBrief,
  runProductAccept,
  runProductDone,
  runProductMigrate,
  runProductNext,
  runProductReview,
  runProductStatus,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../src/workflow/product/index.js";
import { authorizationPath, readProductRecord } from "../../src/workflow/product/store.js";
import { productSourceDigest } from "../../src/workflow/product/subject.js";
import { legacyStore } from "../unit/support/legacy-store.js";
import { moduleFeedback } from "../unit/support/product-feedback.js";
import { recordedProductJourney } from "../unit/support/product-journey.js";
import { pngHeader, TestWorkspace } from "../unit/support/workspace.js";

let workspace: TestWorkspace;
const FEATURE = "001-preserve-the-request";
const command: [string, ...string[]] = [
  process.execPath,
  "-e",
  "const fs=require('node:fs'); require('node:assert/strict').equal(JSON.parse(fs.readFileSync('value.json')).value,2)",
];
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

beforeEach(async () => {
  workspace = await TestWorkspace.create({
    "value.json": '{"value":1}',
    "unrelated.txt": "original",
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.destroy();
});

async function setup(experience = false) {
  await workspace.installFoundation();
  workspace.git("add", "-A");
  workspace.git("commit", "--no-verify", "-qm", "install foundation");
  const created = value(
    await createProductFeature(await workspace.state(), {
      goal: "Preserve the request",
      sourceBrief: "Produce the value 2, with a usable screen.",
    }),
  );
  const brief = value(
    parseProductBrief({
      ...created.brief,
      outcomes: [
        {
          id: "O001",
          kind: experience ? "experience" : "functional",
          statement: "Produces value 2",
          expectations: [{ statement: "value equals 2" }],
        },
      ],
      checks: [{ id: "C001", command, outcomes: ["O001"] }],
      slices: [
        {
          id: "T001",
          goal: "Produce value 2",
          outcomes: ["O001"],
          scope: { allowed: ["value.json"] },
          checks: ["C001"],
        },
      ],
    }),
  );
  value(await updateProductBrief(await workspace.state(), { brief }));
  return brief;
}

describe("product workflow", () => {
  it("creates one authored brief with generated IDs and gives read-only next guidance", async () => {
    const noFeature = value(await runProductNext(await workspace.state()));
    expect(noFeature.action).toBe("understand");
    expect(value(await productScopes(await workspace.state()))).toEqual([]);
    const brief = await setup();
    expect(brief.outcomes[0]?.expectations[0]?.id).toBe("O001_AC1");
    const before = await readdir(join(workspace.root, ".visp/features", FEATURE));
    const next = value(await runProductNext(await workspace.state()));
    expect(next).toMatchObject({ action: "implement", mayEdit: false });
    expect(await readdir(join(workspace.root, ".visp/features", FEATURE))).toEqual(before);
    expect(before.sort()).toEqual(["brief.yaml", "intent.json", "product-state.json"]);
  });

  it("runs actual checks, preserves failures, then closes and accepts only the repaired product", async () => {
    await setup();
    const context = value(await runProductWork(await workspace.state()));
    expect(context).toMatchObject({
      task: "T001",
      mayEdit: true,
      originalRequest: "Produce the value 2, with a usable screen.",
    });
    const failed = value(await runProductDone(await workspace.state()));
    expect(failed.passed).toBe(false);
    expect(failed.executions[0]).toMatchObject({
      status: "failed",
      provenance: "supervisor-executed",
      assertions: "agent-reported",
    });
    expect(value(await runProductNext(await workspace.state())).action).toBe("fix");
    await workspace.write("value.json", '{"value":2}');
    const done = value(await runProductDone(await workspace.state()));
    expect(done.closed).toBe(true);
    const reviewed = value(await runProductReview(await workspace.state()));
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: reviewed.subjectDigest,
        feedback: moduleFeedback(reviewed),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The observed public value is 2 and the real assertion checks the same value.",
            evidence: ["C001"],
            expectations: [
              {
                id: "O001_AC1",
                status: "satisfied",
                reason: "The executed equality check observed value two",
                evidence: ["C001"],
              },
            ],
          },
        ],
      }),
    );
    const accepted = value(await runProductAccept(await workspace.state()));
    expect(accepted.passed).toBe(true);
    expect(value(await runProductNext(await workspace.state())).action).toBe("complete");
    expect(value(await readProductRecord(await workspace.state())).state.executions).toHaveLength(
      3,
    );
  });

  it("rejects unknown explicit and stale active task IDs before any command or state write", async () => {
    await setup();
    const state = await workspace.state();
    const before = await readFile(
      join(workspace.root, ".visp/features", FEATURE, "product-state.json"),
      "utf8",
    );
    const unknown = await runProductVerify(state, { task: "T999" });
    expect(!unknown.ok && unknown.error.code).toBe("TASK_NOT_FOUND");
    expect(await runProductAccept(state, { task: "T999" })).toMatchObject({
      ok: false,
      error: { code: "TASK_NOT_FOUND" },
    });
    value(
      await legacyStore(state).writeStatus({
        kind: "status",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        activeFeature: FEATURE,
        activeTask: "T999",
      }),
    );
    const active = await runProductVerify(await workspace.state());
    expect(!active.ok && active.error.code).toBe("TASK_NOT_FOUND");
    expect(await runProductAccept(await workspace.state())).toMatchObject({
      ok: false,
      error: { code: "TASK_NOT_FOUND" },
    });
    expect(
      await readFile(join(workspace.root, ".visp/features", FEATURE, "product-state.json"), "utf8"),
    ).toBe(before);
  });

  it("keeps prior unrelated changes and catches new changes to those files", async () => {
    await setup();
    await workspace.write("unrelated.txt", "user change before authorization");
    value(await runProductWork(await workspace.state()));
    await workspace.write("value.json", '{"value":2}');
    expect(value(await runProductVerify(await workspace.state())).passed).toBe(true);
    await workspace.write("unrelated.txt", "changed after authorization");
    const outside = await runProductDone(await workspace.state());
    expect(!outside.ok && outside.error.code).toBe("SCOPE_VIOLATION");
  });

  it("reuses successful checks after generated metadata changes and does not relabel receipts", async () => {
    await setup();
    value(await runProductWork(await workspace.state()));
    await workspace.write("value.json", '{"value":2}');
    value(await runProductVerify(await workspace.state()));
    const subject = value(await productSourceDigest(await workspace.state()));
    await workspace.write(".visp/reports/note.json", '{"note":"metadata only"}');
    expect(value(await productSourceDigest(await workspace.state()))).toBe(subject);
    const done = value(await runProductDone(await workspace.state()));
    expect(done.closed).toBe(true);
    expect(done.executions).toEqual([]);
  });

  it("allows revising a method but separately protects durable outcomes and original request", async () => {
    const brief = await setup();
    value(await runProductWork(await workspace.state()));
    const revised = {
      ...brief,
      slices: brief.slices.map((slice) => ({ ...slice, approach: "Use a smaller module" })),
    };
    value(
      await updateProductBrief(await workspace.state(), {
        brief: revised,
        reason: "Simplify the implementation",
      }),
    );
    expect(value(await productScopes(await workspace.state()))).toEqual([]);
    const weakened = {
      ...revised,
      outcomes: revised.outcomes.map((outcome) => ({ ...outcome, priority: "could" })),
    };
    const refused = await updateProductBrief(await workspace.state(), {
      brief: weakened,
      reason: "Skip difficult requirement",
    });
    expect(!refused.ok && refused.error.code).toBe("STAGE_BLOCKED");
    const changedOriginal = await updateProductBrief(await workspace.state(), {
      brief: { ...revised, originalRequest: "Different request" },
      intentChange: { reason: "new brief", provenance: "user stated in host" },
    });
    // A rewritten request is ignored and reported; the recorded request stays.
    expect(changedOriginal.ok && changedOriginal.value.originalRequest).toBe(
      revised.originalRequest,
    );
    value(
      await updateProductBrief(await workspace.state(), {
        brief: weakened,
        intentChange: {
          reason: "User revised the goal",
          provenance: "host conversation; not authenticated by CLI",
        },
      }),
    );
    expect(
      value(await readProductRecord(await workspace.state())).state.revisions.at(-1)?.kind,
    ).toBe("intent");
  });

  it("refuses copied worktree authorizations and rereads current contract digests", async () => {
    await setup();
    value(await runProductWork(await workspace.state()));
    const state = await workspace.state();
    const path = authorizationPath(state, FEATURE);
    const auth = JSON.parse(value(await state.files.readText(path)));
    value(await state.files.writeJson(path, { ...auth, root: "different-worktree" }));
    expect(value(await productScopes(state))).toEqual([]);
  });

  it("schedules visual refinement and cannot close from a claimed review without current images", async () => {
    await setup(true);
    value(await runProductWork(await workspace.state()));
    await workspace.write("value.json", '{"value":2}');
    expect(value(await runProductDone(await workspace.state())).closed).toBe(false);
    expect(value(await runProductNext(await workspace.state())).action).toBe("refine");
    const bundle = value(await runProductReview(await workspace.state()));
    const reviewed = value(
      await runProductReview(await workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [
          { outcome: "O001", status: "satisfied", summary: "Looks fine", evidence: [] },
        ],
      }),
    );
    expect(reviewed.assessments[0]?.status).toBe("unavailable");
    expect(value(await runProductDone(await workspace.state())).closed).toBe(false);
    expect(value(await runProductStatus(await workspace.state())).outcomes[0]?.review).toBe(
      "unavailable",
    );
  });

  it("links current images to judgments, labels supplied captures honestly, and detects missing images", async () => {
    await setup(true);
    value(await runProductWork(await workspace.state()));
    await workspace.write("value.json", '{"value":2}');
    value(await runProductVerify(await workspace.state()));
    const subject = value(await productSourceDigest(await workspace.state()));
    const bytes = pngHeader(640, 480);
    const path = ".visp/reports/review.png";
    await workspace.write(path, bytes);
    const capture = {
      id: "capture-1",
      path,
      sha256: sha256(bytes),
      subjectDigest: subject,
      route: "/User/Alice",
      steps: ["Open screen", "Change value"],
      viewport: { width: 640, height: 480 },
      createdAt: new Date().toISOString(),
      provenance: "runner-captured",
    };
    const reviewed = value(
      await runProductReview(await workspace.state(), {
        subjectDigest: subject,
        captures: [capture],
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The displayed value and journey meet the goal",
            evidence: [capture.id],
            expectations: [
              {
                id: "O001_AC1",
                status: "satisfied",
                reason: "The equality check observed value two",
                evidence: ["C001"],
              },
            ],
          },
        ],
      }),
    );
    expect(reviewed.images[0]?.provenance).toBe("agent-supplied");
    expect(reviewed.assessments[0]?.status).toBe("unavailable");
    expect(reviewed.assessments[0]?.summary).toContain("interaction journey");
    await workspace.write(path, "broken image");
    expect(value(await runProductDone(await workspace.state())).closed).toBe(false);
  });

  it("recognizes the same failing node:test assertion despite changing TAP durations and delivers it in work context", async () => {
    const brief = await setup();
    await workspace.write(
      "check.mjs",
      "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; test('value satisfies original request',()=>assert.equal(JSON.parse(fs.readFileSync('value.json')).value,2));",
    );
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          checks: brief.checks.map((check) => ({
            ...check,
            command: [process.execPath, "--test", "check.mjs"],
          })),
        },
        reason: "Run the actual Node test runner",
      }),
    );
    value(await runProductWork(await workspace.state()));
    value(await runProductVerify(await workspace.state()));
    await workspace.write(".visp/reports/research-note.json", "{}");
    const repeated = value(await runProductVerify(await workspace.state()));
    expect(repeated.recommendation).toContain("different hypothesis");
    const context = value(await runProductWork(await workspace.state()));
    expect(context.feedback[0]).toMatchObject({ check: "C001", status: "failed", current: true });
    expect(context.feedback[0]?.output).toContain("value satisfies original request");
  });

  it("uses the latest visual assessment instead of permanently blocking on a superseded image", async () => {
    await setup(true);
    value(await runProductWork(await workspace.state()));
    await workspace.write("value.json", '{"value":2}');
    value(await runProductVerify(await workspace.state()));
    const subject = value(await productSourceDigest(await workspace.state()));
    for (const id of ["first", "replacement"]) {
      const captures = await recordedProductJourney(workspace, id);
      value(
        await runProductReview(await workspace.state(), {
          subjectDigest: subject,
          assessments: [
            {
              outcome: "O001",
              status: "satisfied",
              summary: "Original goal is satisfied in the observed interaction",
              evidence: captures.map((capture) => capture.id),
              expectations: [
                {
                  id: "O001_AC1",
                  status: "satisfied",
                  reason: "The equality check observed value two",
                  evidence: ["C001"],
                },
              ],
            },
          ],
        }),
      );
    }
    await workspace.write(".visp/reports/first-before.png", "removed old image");
    expect(value(await runProductDone(await workspace.state())).closed).toBe(true);
  });

  it("does not reset the refinement budget through a method revision", async () => {
    const brief = await setup(true);
    value(await runProductWork(await workspace.state()));
    await workspace.write("value.json", '{"value":2}');
    for (let index = 0; index < 3; index++) {
      await workspace.write("value.json", JSON.stringify({ value: 2, transition: index }));
      const subject = value(await productSourceDigest(await workspace.state()));
      value(
        await runProductReview(await workspace.state(), {
          subjectDigest: subject,
          assessments: [
            {
              outcome: "O001",
              status: "failed",
              summary: "The primary interaction still needs inspection",
            },
          ],
        }),
      );
    }
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          slices: brief.slices.map((slice) => ({
            ...slice,
            approach: "Change the implementation approach",
          })),
        },
        reason: "Investigate another hypothesis",
      }),
    );
    expect(value(await runProductReview(await workspace.state())).refinement).toMatchObject({
      used: 2,
      remaining: 0,
      exhausted: true,
    });
  });

  it("checks each usable slice independently before checking the assembled product", async () => {
    const brief = await setup();
    const second: [string, ...string[]] = [
      process.execPath,
      "-e",
      "require('node:assert/strict').equal(JSON.parse(require('node:fs').readFileSync('value.json')).ready,true)",
    ];
    value(
      await updateProductBrief(await workspace.state(), {
        reason: "Build the value before the readiness state",
        brief: {
          ...brief,
          checks: [...brief.checks, { id: "C002", command: second, outcomes: ["O001"] }],
          slices: [
            ...brief.slices,
            {
              id: "T002",
              goal: "Expose readiness",
              outcomes: ["O001"],
              dependsOn: ["T001"],
              scope: { allowed: ["value.json"] },
              checks: ["C002"],
            },
          ],
        },
      }),
    );
    value(await runProductWork(await workspace.state(), { task: "T001" }));
    await workspace.write("value.json", '{"value":2,"ready":false}');
    const first = value(await runProductDone(await workspace.state(), { task: "T001" }));
    expect(first.closed).toBe(true);
    expect(first.executions.map((entry) => entry.check)).toEqual(["C001"]);
    value(await runProductWork(await workspace.state(), { task: "T002" }));
    await workspace.write("value.json", '{"value":2,"ready":true}');
    expect(value(await runProductDone(await workspace.state(), { task: "T002" })).closed).toBe(
      true,
    );
    const bundle = value(await runProductReview(await workspace.state()));
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "Both the value and its readiness state are observed in the final JSON.",
          },
        ],
      }),
    );
    expect(
      value(await runProductAccept(await workspace.state())).executions.map((entry) => entry.check),
    ).toEqual(["C001", "C002"]);
  });

  it("keeps authorization and evidence for an unaffected slice when another method changes", async () => {
    const brief = await setup();
    const extended = value(
      await updateProductBrief(await workspace.state(), {
        reason: "Plan a second independent slice",
        brief: {
          ...brief,
          outcomes: [
            ...brief.outcomes,
            { id: "O002", kind: "quality", statement: "Explain the result" },
          ],
          slices: [
            ...brief.slices,
            {
              id: "T002",
              goal: "Explain the result",
              outcomes: ["O002"],
              scope: { allowed: ["README.md"] },
              checks: [],
            },
          ],
        },
      }),
    );
    value(await runProductWork(await workspace.state(), { task: "T001" }));
    await workspace.write("value.json", '{"value":2}');
    value(await runProductVerify(await workspace.state(), { task: "T001" }));
    value(
      await updateProductBrief(await workspace.state(), {
        reason: "Use prose for the explanation",
        brief: {
          ...extended,
          slices: extended.slices.map((slice) =>
            slice.id === "T002" ? { ...slice, approach: "Write a short example" } : slice,
          ),
        },
      }),
    );
    expect(
      value(await productScopes(await workspace.state())).map((marker) => marker.task),
    ).toEqual(["T001"]);
    const first = value(await runProductDone(await workspace.state(), { task: "T001" }));
    expect(first.closed).toBe(true);
    expect(first.executions).toEqual([]);
  });
});

describe("legacy migration", () => {
  async function legacy(status: "pending" | "done" = "pending") {
    await workspace.withFeature(FEATURE, [
      {
        status,
        requirements: ["REQ001"],
        allowedFiles: ["value.json"],
        validationCommands: [command],
      },
    ]);
    await workspace.withSpec(FEATURE, [
      {
        id: "REQ001",
        statement: "Produce value 2",
        priority: "must",
        criteria: [
          {
            id: "AC001",
            statement: "Value is 2",
            verification: `\`${process.execPath} test.mjs\``,
          },
        ],
      },
    ]);
    await workspace.withPlan(FEATURE);
  }

  it("previews without writes, preserves source bytes, retires markers, and is idempotent", async () => {
    await legacy();
    const state = await workspace.state();
    value(
      await legacyStore(state).writeImplementMarker({
        kind: "implement-marker",
        feature: FEATURE,
        task: "T001",
        createdAt: new Date().toISOString(),
        allowedFiles: ["value.json"],
        expectedFiles: [],
        forbiddenFiles: [],
      }),
    );
    const directory = join(workspace.root, ".visp/features", FEATURE);
    const names = await readdir(directory);
    const before = await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")));
    expect(value(await runProductMigrate(state, { dryRun: true })).features[0]?.status).toBe(
      "migrated",
    );
    expect(await readdir(directory)).toEqual(names);
    value(await runProductMigrate(state));
    expect(await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")))).toEqual(
      before,
    );
    expect(value(await state.store.readActiveMarkers())).toEqual([]);
    expect(value(await runProductMigrate(state)).features[0]?.status).toBe("already-current");
    expect(value(await readProductBrief(state)).outcomes[0]?.id).toBe("REQ001");
    expect(value(await readProductRecord(state)).state.executions).toEqual([]);
  });

  it("keeps incomplete draft references without inventing missing outcomes", async () => {
    await workspace.withFeature(FEATURE, [
      { requirements: ["REQ009"], allowedFiles: ["value.json"] },
    ]);
    value(await runProductMigrate(await workspace.state()));
    const brief = value(await readProductBrief(await workspace.state()));
    expect(brief.incomplete).toBe(true);
    expect(brief.outcomes).toEqual([]);
    expect(brief.slices[0]?.outcomes).toEqual(["REQ009"]);
    expect(value(await runProductNext(await workspace.state())).action).toBe("understand");
  });

  it("keeps historically closed slices without inventing fresh product acceptance", async () => {
    await legacy("done");
    const state = await workspace.state();
    const intent = value(await state.store.readIntent(FEATURE));
    value(await legacyStore(state).writeIntent({ ...intent, finalAcceptance: true }));
    value(await runProductMigrate(state));
    const record = value(await readProductRecord(state));
    expect(record.state.slices.T001?.status).toBe("legacy-closed");
    expect(record.state.status).toBe("active");
    expect(record.state.executions).toEqual([]);
    expect(value(await runProductNext(state)).action).toBe("refine");
  });

  it("keeps genuinely historical completion clearly labeled", async () => {
    await legacy("done");
    value(await runProductMigrate(await workspace.state()));
    const record = value(await readProductRecord(await workspace.state()));
    expect(record.state.status).toBe("historical-complete");
    expect(value(await runProductNext(await workspace.state())).evidence.join()).toContain(
      "historical",
    );
  });

  it("preserves historical completion when an explicit fresh acceptance attempt fails", async () => {
    await legacy("done");
    await workspace.installFoundation();
    const directory = join(workspace.root, ".visp/features", FEATURE);
    const names = await readdir(directory);
    const historicalBytes = await Promise.all(names.map((name) => readFile(join(directory, name))));
    value(await runProductMigrate(await workspace.state()));
    const failed = value(await runProductAccept(await workspace.state()));
    expect(failed.passed).toBe(false);
    expect(failed.executions.some((execution) => execution.status === "failed")).toBe(true);
    const record = value(await readProductRecord(await workspace.state()));
    expect(record.state.status).toBe("historical-complete");
    expect(record.state.acceptedSubject).toBeUndefined();
    expect(record.state.slices.T001?.status).toBe("legacy-closed");
    const next = value(await runProductNext(await workspace.state()));
    expect(next.action).toBe("complete");
    expect(next.evidence.join()).toContain("historical completion, not fresh product verification");
    expect(await Promise.all(names.map((name) => readFile(join(directory, name))))).toEqual(
      historicalBytes,
    );
  });

  it("refuses malformed legacy inputs without creating a brief", async () => {
    await legacy();
    await workspace.write(`.visp/features/${FEATURE}/spec.json`, "malformed");
    const failed = await runProductMigrate(await workspace.state());
    expect(!failed.ok && failed.error.code).toBe("ARTIFACT_INVALID");
    expect(await readdir(join(workspace.root, ".visp/features", FEATURE))).not.toContain(
      "brief.yaml",
    );
  });

  it("recovers an interrupted migration before retrying without partial history changes", async () => {
    await legacy();
    const original = transactions.applyFileTransaction;
    vi.spyOn(transactions, "applyFileTransaction").mockImplementationOnce(
      (root, label, mutations) =>
        original(root, label, mutations, {
          afterMutation: () => {
            throw new Error("simulated interruption");
          },
          leavePreparedOnError: true,
        }),
    );
    const failed = await runProductMigrate(await workspace.state());
    expect(failed.ok).toBe(false);
    vi.restoreAllMocks();
    expect(value(await runProductMigrate(await workspace.state())).features[0]?.status).toBe(
      "migrated",
    );
    expect(value(await readProductRecord(await workspace.state())).state.executions).toEqual([]);
  });

  it("refuses a concurrent legacy edit without partially publishing the migration", async () => {
    await legacy();
    const original = transactions.applyFileTransaction;
    const path = `.visp/features/${FEATURE}/spec.json`;
    const before = await readFile(join(workspace.root, path), "utf8");
    vi.spyOn(transactions, "applyFileTransaction").mockImplementationOnce(
      async (root, label, mutations) => {
        await workspace.write(path, `${before}\n`);
        return original(root, label, mutations);
      },
    );
    const failed = await runProductMigrate(await workspace.state());
    expect(failed.ok).toBe(false);
    expect(await readFile(join(workspace.root, path), "utf8")).toBe(`${before}\n`);
    expect(await readdir(join(workspace.root, ".visp/features", FEATURE))).not.toContain(
      "brief.yaml",
    );
  });
});
