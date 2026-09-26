import { mkdir, readFile, symlink, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as transactions from "../../src/core/file-transaction.js";
import type { Result } from "../../src/core/result.js";
import {
  createProductFeature,
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
import type { ProductBrief } from "../../src/workflow/product/model.js";
import {
  authorizationPath,
  briefPath,
  productStatePath,
  readProductRecord,
} from "../../src/workflow/product/store.js";
import { productSourceDigest, productSourceSnapshot } from "../../src/workflow/product/subject.js";
import { legacyStore } from "../unit/support/legacy-store.js";
import { moduleFeedback } from "../unit/support/product-feedback.js";
import { recordedProductJourney } from "../unit/support/product-journey.js";
import { productWorkspace } from "../unit/support/product-workspace.js";
import type { TestWorkspace } from "../unit/support/workspace.js";

let workspace: TestWorkspace;
let brief: ProductBrief;
const LEGACY = "090-legacy";
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
beforeEach(async () => {
  ({ workspace, brief } = await productWorkspace());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.destroy();
});
async function contents() {
  return readFile(productStatePath(await workspace.state(), brief.feature), "utf8");
}
async function repairAndClose() {
  value(await runProductWork(await workspace.state()));
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  expect(value(await runProductDone(await workspace.state())).closed).toBe(true);
}

describe("product input and source trust boundaries", () => {
  it.each(["../escape", "", "001-UPPER"])(
    "rejects invalid migration feature %s before a filesystem lookup",
    async (feature) => {
      const state = await workspace.state();
      const read = vi.spyOn(state.files, "exists");
      expect(await runProductMigrate(state, { feature, dryRun: true })).toMatchObject({
        ok: false,
        error: { code: "ARTIFACT_INVALID" },
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("distinguishes missing features from legacy mutation and rejects a missing required legacy intent", async () => {
    const state = await workspace.state();
    expect(await readProductBrief(state, { feature: "999-missing" })).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_MISSING" },
    });
    expect(await runProductMigrate(state, { feature: "999-missing" })).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_MISSING" },
    });
    await workspace.withFeature(LEGACY);
    expect(await readProductBrief(await workspace.state())).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_REQUIRED" },
    });
    expect(value(await runProductStatus(await workspace.state())).next.command).toContain(
      "migrate",
    );
  });
  it.each([
    "[bad",
    "version: 2\nfeature: 123",
    "version: 2\nfeature: 002-other\ngoal: changed\noriginalRequest: changed\n",
  ])(
    "rejects malformed or mismatched authored briefs without changing machine state",
    async (text) => {
      const state = await workspace.state();
      const before = await contents();
      await workspace.write(relative(workspace.root, briefPath(state, brief.feature)), text);
      expect(await readProductRecord(state)).toMatchObject({
        ok: false,
        error: { code: "ARTIFACT_INVALID" },
      });
      expect(await contents()).toBe(before);
    },
  );
  it.each(["{broken", "{}", JSON.stringify({ version: 2, feature: "002-other" })])(
    "rejects malformed generated state instead of treating it as no evidence",
    async (text) => {
      const state = await workspace.state();
      await workspace.write(relative(workspace.root, productStatePath(state, brief.feature)), text);
      expect(await readProductRecord(state)).toMatchObject({
        ok: false,
        error: { code: "ARTIFACT_INVALID" },
      });
    },
  );
  it("rejects a valid state copied from another feature", async () => {
    const state = await workspace.state();
    const record = value(await readProductRecord(state));
    await workspace.write(
      relative(workspace.root, productStatePath(state, brief.feature)),
      JSON.stringify({ ...record.state, feature: "002-other" }),
    );
    expect(await readProductRecord(state)).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID" },
    });
  });
  it("rejects directory symlinks before reading bytes and keeps the external symlink boundary", async () => {
    await mkdir(join(workspace.root, "local-dir"));
    await symlink("local-dir", join(workspace.root, "directory-link"));
    expect(await productSourceSnapshot(await workspace.state())).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED" },
    });
    await unlink(join(workspace.root, "directory-link"));
    await symlink("/etc/passwd", join(workspace.root, "external-link"));
    const external = await productSourceSnapshot(await workspace.state());
    expect(external.ok).toBe(false);
    if (!external.ok) expect(external.error.message).toMatch(/outside|escape|symlink/i);
  });
  it("changes source identity for tracked deletion and supports an ordinary internal file symlink", async () => {
    const before = value(await productSourceDigest(await workspace.state()));
    await unlink(join(workspace.root, "src/value.mjs"));
    expect(value(await productSourceDigest(await workspace.state()))).not.toBe(before);
    await workspace.write("src/value.mjs", "export const value = 1;\n");
    await symlink("src/value.mjs", join(workspace.root, "internal-link"));
    expect(await productSourceSnapshot(await workspace.state())).toMatchObject({ ok: true });
  });
  it("can inspect a repository without an active feature and confines broad declared file patterns", async () => {
    const state = await workspace.state();
    const independent = { ...state, status: undefined };
    expect(value(await productSourceSnapshot(independent))).toHaveProperty("src/value.mjs");
    await workspace.write(".visp/helper.mjs", "export const expected = 2;");
    const snapshot = value(
      await productSourceSnapshot(state, {
        ...brief,
        checks: brief.checks.map((check) => ({ ...check, files: ["**/*.mjs"] })),
      }),
    );
    expect(snapshot).toHaveProperty(".visp/helper.mjs");
    expect(Object.keys(snapshot).some((path) => path.startsWith(".git/"))).toBe(false);
  });
  it("returns a clear unsupported result for gitlinks whether initialized or absent", async () => {
    const head = workspace.git("rev-parse", "HEAD").trim();
    workspace.git("update-index", "--add", "--cacheinfo", `160000,${head},vendor/module`);
    expect(await productSourceSnapshot(await workspace.state())).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED" },
    });
    await workspace.write("vendor/module/file.txt", "checked out");
    expect(await productSourceSnapshot(await workspace.state())).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED" },
    });
  });
  it("rejects empty goals, changed IDs, missing method reasons, and accepts an identical update without churn", async () => {
    const state = await workspace.state();
    expect(await createProductFeature(state, { goal: "  " })).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID" },
    });
    expect(
      await updateProductBrief(state, {
        brief: { ...brief, feature: "002-other" },
        reason: "changed",
      }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
    expect(
      await updateProductBrief(state, { brief: { ...brief, uncertainties: ["new question"] } }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
    const before = await contents();
    expect(await updateProductBrief(state, { brief })).toMatchObject({ ok: true });
    expect(await contents()).toBe(before);
  });
  it.each(["malformed", "{}"])(
    "retires invalid authorization during a validated method revision: %s",
    async (content) => {
      const state = await workspace.state();
      await workspace.write(
        relative(workspace.root, authorizationPath(state, brief.feature)),
        content,
      );
      value(
        await updateProductBrief(state, {
          brief: { ...brief, uncertainties: ["Investigate the boundary"] },
          reason: "Focused question",
        }),
      );
      expect(value(await state.files.exists(authorizationPath(state, brief.feature)))).toBe(false);
    },
  );
  it("creates requested feature branches and reports a collision without losing the created feature", async () => {
    const first = value(
      await createProductFeature(await workspace.state(), { goal: "First branch", branch: true }),
    );
    expect(first.branchCreated).toBe(`feature/${first.brief.feature}`);
    workspace.git("branch", "feature/003-collision");
    const collision = value(
      await createProductFeature(await workspace.state(), { goal: "Collision", branch: true }),
    );
    expect(collision.branchWarning).toBeTruthy();
    expect(value(await readProductBrief(await workspace.state())).feature).toBe(
      collision.brief.feature,
    );
  });
});

describe("transactional legacy migration", () => {
  async function legacy() {
    await workspace.withFeature(LEGACY, [{ status: "done", requirements: ["REQ001"] }]);
    await workspace.withSpec(LEGACY, [
      {
        id: "REQ001",
        priority: "must",
        statement: "Preserve two",
        criteria: [{ id: "AC001", statement: "Value two", verification: "manual check" }],
      },
    ]);
  }
  it("preserves priorities, visual intent, behavior examples, research evidence and unresolved questions", async () => {
    await legacy();
    const state = await workspace.state();
    const spec = value(await legacyStore(state).readSpec(LEGACY));
    value(
      await legacyStore(state).writeSpec({
        ...spec,
        requirements: [
          {
            id: "REQ001",
            statement: "Preserve the value",
            priority: "must",
            criteria: [{ id: "AC001", statement: "Value is two" }],
          },
        ],
        qualityRequirements: [
          {
            id: "NFR001",
            category: "visual",
            statement: "Expose the value clearly",
            target: "Readable after start",
            priority: "must",
            criteria: [
              {
                id: "AC002",
                statement: "Rendered value is readable",
                verification: "```sh\nnode browser-check.mjs\n```",
                verificationEnvironment: "browser",
                observationKind: "visual",
              },
            ],
          },
          {
            id: "NFR002",
            category: "performance",
            statement: "Keep startup fast",
            target: "Under 200ms",
            priority: "should",
            criteria: [],
          },
        ],
        behaviorScenarios: [
          {
            id: "SCN001",
            title: "Start the display",
            given: ["A ready page"],
            when: "Press Start",
            expected: ["Value two appears"],
            requirements: ["REQ001"],
          },
        ],
        designBrief: {
          schemaVersion: 1,
          audience: "Readers",
          primaryJourneys: ["Start then inspect value"],
          references: [{ source: "docs/reference.png", purpose: "Readable hierarchy" }],
          visualDirection: "Clear controls",
          typography: "Readable labels",
          spacing: "Group related content",
          responsiveBehavior: "Fits a phone",
          states: ["initial", "started"],
          accessibility: ["Keyboard activation"],
          viewports: [],
        },
        openQuestions: ["Which narrow viewport is representative?"],
      }),
    );
    value(
      await legacyStore(state).writeResearch({
        kind: "research",
        createdAt: new Date().toISOString(),
        feature: LEGACY,
        mode: "enhancement",
        draft: false,
        summary: "Check actual transitions",
        questions: [
          {
            id: "RQ001",
            question: "When does the value become visible?",
            status: "answered",
            answer: "After the Start interaction",
          },
          { id: "RQ002", question: "Which reduced-motion preference?", status: "open" },
          { id: "RQ003", question: "Can mobile controls differ?", status: "deferred" },
        ],
        findings: [
          {
            id: "FND001",
            classification: "fact",
            statement: "Start triggers the display",
            confidence: "high",
            question: "RQ001",
            sources: [{ kind: "repository", reference: "src/value.mjs", detail: "Start handler" }],
            implications: [{ kind: "test", statement: "Check the intermediate state" }],
            challenge: {
              method: "experiment",
              outcome: "supported",
              detail: "Observed the transition",
              falsifier: "Value visible before Start",
            },
          },
          {
            id: "FND002",
            classification: "inference",
            statement: "Labels may wrap",
            confidence: "low",
            sources: [{ kind: "repository", reference: "index.html", detail: "" }],
            implications: [],
          },
        ],
        unknowns: ["Unmeasured small-screen behavior"],
      }),
    );
    await workspace.withPlan(LEGACY);
    const plan = value(await legacyStore(state).readPlan(LEGACY));
    value(
      await legacyStore(state).writePlan({
        ...plan,
        decisions: [
          { statement: "Keep one event handler", rationale: "Prevent divergent transitions" },
        ],
        invariants: ["Value changes only after activation"],
        risks: ["Reduced-motion behavior remains unresolved"],
      }),
    );
    const before = await readFile(
      join(workspace.root, `.visp/features/${LEGACY}/research.json`),
      "utf8",
    );
    value(await runProductMigrate(await workspace.state(), { feature: LEGACY }));
    const migrated = value(await readProductBrief(await workspace.state(), { feature: LEGACY }));
    expect(
      migrated.outcomes.map((outcome) => [outcome.id, outcome.kind, outcome.priority]),
    ).toEqual([
      ["REQ001", "functional", "must"],
      ["NFR001", "experience", "must"],
      ["NFR002", "quality", "should"],
    ]);
    expect(migrated.outcomes[1]).toMatchObject({
      target: "Readable after start",
      reviewRequired: true,
    });
    expect(migrated.checks.find((check) => check.id === "AC002")).toMatchObject({
      command: "node browser-check.mjs",
      environment: "browser",
    });
    expect(migrated.examples[0]?.expected).toEqual(["Value two appears"]);
    expect(migrated.design?.references).toEqual(["docs/reference.png"]);
    expect(migrated.decisions.find((decision) => decision.id === "FND001")?.rationale).toContain(
      "Value visible before Start",
    );
    expect(migrated.decisions.find((decision) => decision.id === "RQ001")?.rationale).toBe(
      "After the Start interaction",
    );
    expect(migrated.uncertainties).toEqual(
      expect.arrayContaining([
        "Which reduced-motion preference?",
        "Can mobile controls differ?",
        "Unmeasured small-screen behavior",
      ]),
    );
    expect(
      await readFile(join(workspace.root, `.visp/features/${LEGACY}/research.json`), "utf8"),
    ).toBe(before);
  });
  it("aborts atomically when an optional legacy file appears after it was read absent", async () => {
    await legacy();
    const path = `.visp/features/${LEGACY}/research.json`;
    const original = transactions.applyFileTransaction;
    vi.spyOn(transactions, "applyFileTransaction").mockImplementationOnce(
      async (root, label, mutations) => {
        await workspace.write(path, '{"concurrent":"must not disappear"}');
        return original(root, label, mutations);
      },
    );
    expect(await runProductMigrate(await workspace.state(), { feature: LEGACY })).toMatchObject({
      ok: false,
    });
    expect(await readFile(join(workspace.root, path), "utf8")).toBe(
      '{"concurrent":"must not disappear"}',
    );
    expect(
      value(await (await workspace.state()).files.exists(`.visp/features/${LEGACY}/brief.yaml`)),
    ).toBe(false);
  });
  it("does not credit passing acceptance belonging to another feature", async () => {
    await legacy();
    const state = await workspace.state();
    const intent = value(await state.store.readIntent(LEGACY));
    value(await legacyStore(state).writeIntent({ ...intent, finalAcceptance: true }));
    await workspace.write(
      `.visp/features/${LEGACY}/acceptance.json`,
      JSON.stringify({
        kind: "product-acceptance",
        createdAt: new Date().toISOString(),
        feature: "091-unrelated",
        subject: "a".repeat(64),
        passed: true,
        criteria: [
          {
            criterion: "AC001",
            requirement: "REQ001",
            outcome: "passed",
            statement: "Legacy behavior passed",
          },
        ],
        commands: [],
        findings: [],
      }),
    );
    const result = await runProductMigrate(state, { feature: LEGACY });
    expect(result).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
    if (!result.ok) expect(result.error.message).toContain("feature mismatch");
  });
  it("rejects wrong-feature intent and invalid optional schemas without publishing a destination", async () => {
    await legacy();
    const state = await workspace.state();
    const intent = value(await state.store.readIntent(LEGACY));
    await workspace.write(
      `.visp/features/${LEGACY}/intent.json`,
      JSON.stringify({ ...intent, id: "091-unrelated" }),
    );
    expect(await runProductMigrate(state, { feature: LEGACY })).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID" },
    });
    await workspace.write(`.visp/features/${LEGACY}/intent.json`, JSON.stringify(intent));
    await workspace.write(
      `.visp/features/${LEGACY}/plan.json`,
      JSON.stringify({ kind: "plan", feature: LEGACY }),
    );
    expect(await runProductMigrate(state, { feature: LEGACY })).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID" },
    });
  });
});

describe("closed product feedback", () => {
  it("reauthorizes only an explicitly implicated closed slice and preserves closure history", async () => {
    await repairAndClose();
    const before = value(await readProductRecord(await workspace.state()));
    expect(before.state.sliceHistory.at(-1)?.to).toBe("closed");
    expect(await runProductWork(await workspace.state(), { task: "T001" })).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED" },
    });
    const review = value(await runProductReview(await workspace.state()));
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: review.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "failed",
            summary:
              "The value is right, but the public module returns it after the requested transition rather than during it.",
          },
        ],
      }),
    );
    expect(value(await runProductNext(await workspace.state()))).toMatchObject({
      action: "fix",
      command: expect.stringContaining("work"),
    });
    const reopened = value(await runProductWork(await workspace.state(), { task: "T001" }));
    expect(reopened.reviewFeedback.at(-1)).toMatchObject({
      current: true,
      assessments: [{ status: "failed" }],
    });
    const after = value(await readProductRecord(await workspace.state()));
    expect(after.state.slices.T001?.status).toBe("in-progress");
    expect(after.state.sliceHistory.map((entry) => entry.to)).toEqual(["closed", "in-progress"]);
    expect(after.state.executions).toEqual(before.state.executions);
    expect(after.state.revisions).toEqual(before.state.revisions);
  });
  it("does not reopen for optional style findings or stale mandatory findings", async () => {
    brief = value(
      await updateProductBrief(await workspace.state(), {
        reason: "Optional explanation slice",
        brief: {
          ...brief,
          outcomes: [
            ...brief.outcomes,
            {
              id: "O002",
              kind: "quality",
              priority: "should",
              statement: "The explanation reads smoothly",
            },
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
    await repairAndClose();
    value(await runProductWork(await workspace.state(), { task: "T002" }));
    expect(value(await runProductDone(await workspace.state(), { task: "T002" })).closed).toBe(
      true,
    );
    const bundle = value(await runProductReview(await workspace.state()));
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [
          { outcome: "O002", status: "failed", summary: "An optional heading could be shorter" },
        ],
      }),
    );
    expect(await runProductWork(await workspace.state(), { task: "T002" })).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED" },
    });
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "failed",
            summary: "The observed intermediate transition is incorrect",
          },
        ],
      }),
    );
    expect(await runProductWork(await workspace.state(), { task: "T002" })).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED" },
    });
    await workspace.write("src/value.mjs", "export const value = 2; // changed since review\n");
    expect(await runProductWork(await workspace.state(), { task: "T001" })).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED" },
    });
  });
  it("keeps closed sibling files outside a later slice authorization", async () => {
    brief = value(
      await updateProductBrief(await workspace.state(), {
        reason: "Explain after implementing",
        brief: {
          ...brief,
          outcomes: [
            ...brief.outcomes,
            {
              id: "O002",
              kind: "quality",
              priority: "should",
              statement: "Explain how the value is produced",
            },
          ],
          slices: [
            ...brief.slices,
            {
              id: "T002",
              goal: "Explain the value",
              outcomes: ["O002"],
              scope: { allowed: ["README.md"] },
              checks: [],
            },
          ],
        },
      }),
    );
    await repairAndClose();
    value(await runProductWork(await workspace.state(), { task: "T002" }));
    await workspace.write("README.md", "The value is produced by the public module.\n");
    await workspace.write("src/value.mjs", "export const value = 3;\n");
    expect(await runProductDone(await workspace.state(), { task: "T002" })).toMatchObject({
      ok: false,
      error: { code: "SCOPE_VIOLATION" },
    });
  });
  it("does not close reopened work while a known independent expectation still fails", async () => {
    brief = value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          outcomes: brief.outcomes.map((outcome) => ({
            ...outcome,
            expectations: [
              {
                id: "AC001",
                statement: "The intermediate transition exposes value two",
                provenance: "independent",
              },
            ],
          })),
        },
        intentChange: {
          reason: "Preserve independent transition acceptance",
          provenance: "test user expectation",
        },
      }),
    );
    await repairAndClose();
    const bundle = value(await runProductReview(await workspace.state()));
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The final value is correct",
            expectations: [
              {
                id: "AC001",
                status: "failed",
                reason: "The intermediate transition still exposes value one",
              },
            ],
          },
        ],
      }),
    );
    value(await runProductWork(await workspace.state(), { task: "T001" }));
    const done = value(await runProductDone(await workspace.state(), { task: "T001" }));
    expect(done.closed).toBe(false);
    expect(done.gaps.join()).toContain("review failed");
  });
  it("keeps the refinement budget when final review switches to a reopened slice", async () => {
    await repairAndClose();
    const bundle = value(await runProductReview(await workspace.state()));
    const assessments = [
      { outcome: "O001", status: "failed", summary: "The intermediate transition is incorrect" },
    ];
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments,
      }),
    );
    value(await runProductWork(await workspace.state(), { task: "T001" }));
    const sameSource = value(
      await runProductReview(await workspace.state(), {
        task: "T001",
        subjectDigest: bundle.subjectDigest,
        assessments,
      }),
    );
    expect(sameSource.refinement.used).toBe(0);
    for (let cycle = 1; cycle <= 2; cycle++) {
      await workspace.write(
        "src/value.mjs",
        `export const value = 2; export const transition = ${cycle};\n`,
      );
      const current = value(await runProductReview(await workspace.state(), { task: "T001" }));
      value(
        await runProductReview(await workspace.state(), {
          task: "T001",
          subjectDigest: current.subjectDigest,
          assessments,
        }),
      );
      value(await runProductVerify(await workspace.state(), { task: "T001" }));
    }
    const second = value(await runProductReview(await workspace.state(), { task: "T001" }));
    expect(second.refinement).toMatchObject({ used: 2, exhausted: true });
    expect(value(await runProductNext(await workspace.state(), { task: "T001" }))).toMatchObject({
      action: "fix",
      mayEdit: true,
    });
    // A repeated work call must not clear failure history or create another allowance.
    expect(
      value(await runProductReview(await workspace.state(), { task: "T001" })).refinement.used,
    ).toBe(2);
  });
  it("keeps a missing accepted image unresolved without looping on a terminal status command", async () => {
    brief = value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          outcomes: brief.outcomes.map((outcome) => ({ ...outcome, kind: "experience" })),
        },
        intentChange: {
          reason: "Screen is part of the requirement",
          provenance: "test user request",
        },
      }),
    );
    value(await runProductWork(await workspace.state()));
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    const state = await workspace.state();
    const subject = value(await productSourceDigest(state));
    const captures = await recordedProductJourney(workspace, "accepted");
    const path = captures[0]?.path ?? "missing";
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: subject,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary:
              "The rendered result matches the required outcome before and after the observed interaction.",
            evidence: captures.map((capture) => capture.id),
          },
        ],
      }),
    );
    expect(value(await runProductDone(await workspace.state())).closed).toBe(true);
    const qualityBundle = value(await runProductReview(await workspace.state()));
    const quality = moduleFeedback(qualityBundle);
    quality.probes = quality.probes?.map((probe) => ({
      ...probe,
      expected: "The fixture screen remains usable before and after its interaction",
      basis: "Retained screen outcome in the test fixture",
      exercise: "Inspect recorded before and after images and executed interaction",
      observed: "The controlled fixture supplies intact images for both states",
      evidence: [...captures.map((capture) => capture.id), "C001"],
    }));
    quality.dimensions = quality.dimensions.map((entry) =>
      entry.dimension === "experience"
        ? {
            ...entry,
            status: "satisfied",
            reason: "The recorded journey fixture supplies intact before and after images",
            evidence: [...captures.map((capture) => capture.id), "C001"],
          }
        : entry,
    );
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: qualityBundle.subjectDigest,
        feedback: quality,
        assessments: [],
      }),
    );
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
    const complete = value(await runProductNext(await workspace.state()));
    expect(complete.action).toBe("complete");
    expect(complete.command).toBeUndefined();
    expect(value(await runProductStatus(await workspace.state())).report).not.toContain(
      "undefined",
    );
    await unlink(join(workspace.root, path));
    const next = value(await runProductNext(await workspace.state()));
    expect(next.action).toBe("refine");
    expect(next.evidence.join()).toMatch(/image|capture/);
  });
});
