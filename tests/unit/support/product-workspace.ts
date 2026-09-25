import {
  createProductFeature,
  type ProductBrief,
  updateProductBrief,
} from "../../../src/workflow/product/index.js";
import { TestWorkspace } from "./workspace.js";

/** Real product setup shared by adapter tests; the verifier reads the public module. */
export async function productWorkspace(options: { critic?: boolean } = {}): Promise<{
  workspace: TestWorkspace;
  brief: ProductBrief;
}> {
  const workspace = await TestWorkspace.create(
    {
      "src/value.mjs": "export const value = 1;\n",
      "test/value.test.mjs":
        "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('the promised value',()=>assert.equal(value,2));\n",
    },
    options,
  );
  try {
    await workspace.installFoundation();
    workspace.commit("install foundation");
    const started = await createProductFeature(await workspace.state(), {
      goal: "Return two from the public module",
    });
    if (!started.ok) throw new Error(started.error.message);
    const updated = await updateProductBrief(await workspace.state(), {
      brief: {
        ...started.value.brief,
        outcomes: [
          {
            id: "O001",
            kind: "functional",
            statement: "The public value is two",
            priority: "must",
            provenance: "user-stated",
          },
        ],
        checks: [
          {
            id: "C001",
            command: [process.execPath, "--test", "test/value.test.mjs"],
            outcomes: ["O001"],
            files: ["src/value.mjs", "test/value.test.mjs"],
            environment: "node",
          },
        ],
        slices: [
          {
            id: "T001",
            goal: "Return the promised value",
            outcomes: ["O001"],
            scope: {
              allowed: ["src/value.mjs", "test/value.test.mjs"],
              expected: ["src/value.mjs"],
              forbidden: [],
            },
            checks: ["C001"],
          },
        ],
      },
      reason: "Define the first usable behavior",
    });
    if (!updated.ok) throw new Error(updated.error.message);
    return { workspace, brief: updated.value };
  } catch (error) {
    await workspace.destroy();
    throw error;
  }
}
