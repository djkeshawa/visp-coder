import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "../../src/core/result.js";
import { executeChecks } from "../../src/workflow/product/check-lifecycle.js";
import {
  createProductFeature,
  parseProductBrief,
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../src/workflow/product/index.js";
import { readProductRecord } from "../../src/workflow/product/store.js";
import { productSourceDigest, productSourceSnapshot } from "../../src/workflow/product/subject.js";
import { moduleFeedback } from "../unit/support/product-feedback.js";
import { TestWorkspace } from "../unit/support/workspace.js";

/**
 * The subject no longer carries the toolchain, so these tests are what keeps evidence honest:
 * a pass earned under one toolchain must never stand for another, whichever way it is reused.
 */
let workspace: TestWorkspace;
const command: [string, ...string[]] = [
  process.execPath,
  "-e",
  "const fs=require('node:fs'); require('node:assert/strict').equal(JSON.parse(fs.readFileSync('value.json')).value,2)",
];
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
const state = () => workspace.state();

beforeEach(async () => {
  workspace = await TestWorkspace.create({ "value.json": '{"value":1}' });
  await workspace.installFoundation();
  workspace.git("add", "-A");
  workspace.git("commit", "--no-verify", "-qm", "install foundation");
  const created = value(
    await createProductFeature(await state(), {
      goal: "Preserve the request",
      sourceBrief: "Produce the value 2.",
    }),
  );
  const brief = value(
    parseProductBrief({
      ...created.brief,
      outcomes: [
        {
          id: "O001",
          kind: "functional",
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
  value(await updateProductBrief(await state(), { brief }));
  value(await runProductWork(await state()));
  await workspace.write("value.json", '{"value":2}');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await workspace.destroy();
});

const ran = (result: { executions: readonly { check: string }[] }) =>
  result.executions.map((entry) => entry.check);

describe("comparison-gated reuse of passed checks", () => {
  it("done reuses a pass that verify earned under the same toolchain", async () => {
    expect(value(await runProductVerify(await state())).passed).toBe(true);
    const reused = value(await runProductDone(await state()));
    expect(reused.closed).toBe(true);
    expect(ran(reused)).toEqual([]);
  });

  it("done reruns a check that verify passed under a different NODE_OPTIONS", async () => {
    expect(value(await runProductVerify(await state())).passed).toBe(true);
    vi.stubEnv("NODE_OPTIONS", "--no-warnings");
    const done = value(await runProductDone(await state()));
    expect(done.closed).toBe(true);
    expect(ran(done)).toEqual(["C001"]);
  });

  it.each([
    ["PYTHONPATH", "/a/toolchain"],
    ["LANG", "xx_XX.UTF-8"],
    ["TZ", "Pacific/Auckland"],
    ["CHROME_BIN", "/another/browser"],
  ])("done reruns a check that verify passed under a different %s", async (name, changed) => {
    expect(value(await runProductVerify(await state())).passed).toBe(true);
    vi.stubEnv(name, changed);
    expect(ran(value(await runProductDone(await state())))).toEqual(["C001"]);
  });

  it("a plain accept always executes under the reader's environment", async () => {
    expect(value(await runProductDone(await state())).closed).toBe(true);
    expect(ran(value(await runProductAccept(await state())))).toEqual(["C001"]);
  });

  it("a pending verification of the same batch is reused only under the same toolchain", async () => {
    const record = value(await readProductRecord(await state()));
    const snapshot = value(await productSourceSnapshot(await state(), record.brief));
    const source = value(await productSourceDigest(await state(), record.brief, snapshot));
    const run = async (options = {}) => {
      const current = value(await readProductRecord(await state()));
      return value(
        await executeChecks(
          await state(),
          current,
          current.brief.slices[0],
          source,
          current.brief.checks,
          false,
          false,
          options,
          snapshot,
        ),
      );
    };
    expect(ran({ executions: await run() })).toEqual(["C001"]);
    expect((await readProductRecord(await state())).ok).toBe(true);
    const pending = value(await readProductRecord(await state())).state.pendingVerification;
    expect(pending).toBeDefined();
    expect(await run()).toHaveLength(0);
    vi.stubEnv("NODE_OPTIONS", "--no-warnings");
    expect(await run()).toHaveLength(1);
  });
});

describe("reader-stable subject and next", () => {
  async function accepted() {
    expect(value(await runProductDone(await state())).closed).toBe(true);
    const reviewed = value(await runProductReview(await state()));
    value(
      await runProductReview(await state(), {
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
    expect(value(await runProductAccept(await state())).passed).toBe(true);
  }

  it("accept's second pass (reusePassed) reuses under the same toolchain and reruns under another", async () => {
    await accepted();
    const same = value(await runProductAccept(await state(), { reusePassed: true }));
    expect(ran(same)).toEqual([]);
    vi.stubEnv("NODE_OPTIONS", "--no-warnings");
    const other = value(await runProductAccept(await state(), { reusePassed: true }));
    expect(ran(other)).toEqual(["C001"]);
  });

  const differentReaders: readonly [string, () => void][] = [
    ["a longer PATH", () => vi.stubEnv("PATH", `${process.env.PATH}:/opt/extra/bin`)],
    ["a minimal PATH", () => vi.stubEnv("PATH", "/usr/bin:/bin")],
    ["NODE_OPTIONS", () => vi.stubEnv("NODE_OPTIONS", "--no-warnings")],
    [
      "terminal and locale",
      () => {
        vi.stubEnv("TERM", "dumb");
        vi.stubEnv("LANG", "xx_XX.UTF-8");
        vi.stubEnv("TZ", "Pacific/Auckland");
        vi.stubEnv("CI", "1");
      },
    ],
    ["another browser", () => vi.stubEnv("CHROME_BIN", "/another/browser")],
    [
      "another node",
      () => {
        vi.spyOn(process, "version", "get").mockReturnValue("v0.0.0-other");
        vi.spyOn(process, "execPath", "get").mockReturnValue("/opt/other/bin/node");
      },
    ],
  ];

  it.each(differentReaders)(
    "next is identical and complete for a reader with %s",
    async (_name, change) => {
      await accepted();
      const before = value(await runProductNext(await state()));
      expect(before.action).toBe("complete");
      const subject = value(await productSourceDigest(await state()));
      change();
      expect(value(await productSourceDigest(await state()))).toBe(subject);
      expect(value(await runProductNext(await state()))).toEqual(before);
    },
  );
});
