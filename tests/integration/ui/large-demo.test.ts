import { cp } from "node:fs/promises";
import { it, vi } from "vitest";
import type { Result } from "../../../src/core/result.js";
import {
  createProductFeature,
  runProductDone,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../src/workflow/product/index.js";
import { TestWorkspace } from "../../unit/support/workspace.js";

// The trail keeps the newest 100 executions plus those reviews cite (trail.ts), so a
// feature reaches the spec's 200 only when reviews cite older runs. Seeding has no
// reviews, so compaction is held off here; every execution is still a real run.
vi.mock("../../../src/workflow/product/trail.js", async (original) => ({
  ...(await original<typeof import("../../../src/workflow/product/trail.js")>()),
  compactTrail: <T>(state: T) => state,
}));

const SLICES = 20;
const RUNS_PER_SLICE = 10;

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const id = (n: number) => String(n).padStart(2, "0");
const source = (n: number, round: number) =>
  `export const value = () => ${round % 3 === 0 ? 0 : n}; // round ${round}\n`;
const test = (n: number) =>
  `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/m${id(n)}.mjs';\ntest('module ${n} returns ${n}', () => assert.equal(value(), ${n}));\n`;

/**
 * Seeds the spec §16 size target for `visp ui` (20 slices, 200 executions) through the
 * same services the CLI runs, and copies it to the directory named. Off by default:
 *   VISP_UI_LARGE=/tmp/visp-ui-large pnpm vitest run tests/integration/ui/large-demo.test.ts
 *   visp ui --project /tmp/visp-ui-large
 */
it.skipIf(!process.env.VISP_UI_LARGE)(
  "seeds a feature with 20 slices and 200 executions for visp ui",
  async () => {
    const files: Record<string, string> = {};
    for (let n = 1; n <= SLICES; n++) {
      files[`src/m${id(n)}.mjs`] = source(n, 0);
      files[`test/m${id(n)}.test.mjs`] = test(n);
    }
    const workspace = await TestWorkspace.create(files);
    try {
      await workspace.installFoundation();
      workspace.commit("install foundation");
      const created = value(
        await createProductFeature(await workspace.state(), {
          goal: "Twenty modules each return their own number",
          sourceBrief: "Each of the twenty modules m01 to m20 must return its own number.",
        }),
      );
      const feature = created.brief.feature;
      const range = Array.from({ length: SLICES }, (_, i) => i + 1);
      value(
        await updateProductBrief(await workspace.state(), {
          brief: {
            ...created.brief,
            outcomes: range.map((n) => ({
              id: `O0${id(n)}`,
              kind: "functional" as const,
              statement: `Module ${n} returns ${n}`,
              priority: "must" as const,
              provenance: "user-stated" as const,
            })),
            checks: range.map((n) => ({
              id: `C0${id(n)}`,
              command: [process.execPath, "--test", `test/m${id(n)}.test.mjs`],
              outcomes: [`O0${id(n)}`],
              files: [`src/m${id(n)}.mjs`, `test/m${id(n)}.test.mjs`],
              environment: "node" as const,
            })),
            slices: range.map((n) => ({
              id: `T0${id(n)}`,
              goal: `Module ${n} returns ${n}`,
              outcomes: [`O0${id(n)}`],
              scope: {
                allowed: [`src/m${id(n)}.mjs`],
                expected: [`src/m${id(n)}.mjs`],
                forbidden: [],
              },
              checks: [`C0${id(n)}`],
            })),
          },
          reason: "One slice per module",
        }),
      );
      for (const n of range) {
        const task = `T0${id(n)}`;
        value(await runProductWork(await workspace.state(), { feature, task }));
        // Each round changes the module, so every verify records a new execution;
        // every third round fails, so the thread mixes passes, failures and stale runs.
        for (let round = 1; round < RUNS_PER_SLICE; round++) {
          await workspace.write(`src/m${id(n)}.mjs`, source(n, round));
          value(await runProductVerify(await workspace.state(), { feature, task }));
        }
        await workspace.write(`src/m${id(n)}.mjs`, source(n, RUNS_PER_SLICE + 1));
        value(await runProductDone(await workspace.state(), { feature, task }));
      }
      workspace.commit("twenty modules");
      await cp(workspace.root, process.env.VISP_UI_LARGE as string, { recursive: true });
      console.log(`seeded ${feature} in ${process.env.VISP_UI_LARGE}`);
    } finally {
      await workspace.destroy();
    }
  },
  1_800_000,
);
