import { afterEach, expect, it, vi } from "vitest";
import * as executables from "../../../../src/core/command-executable.js";
import { executeProductCheck } from "../../../../src/workflow/product/check-execution.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
afterEach(async () => {
  vi.restoreAllMocks();
  await setup?.workspace.destroy();
});

it.each([false, true])(
  "hashes command executables only for declared verifier inputs: %s",
  async (declared) => {
    setup = await productWorkspace();
    const state = await setup.workspace.state();
    const record = await readProductRecord(state);
    const snapshot = await productSourceSnapshot(state, setup.brief);
    if (!record.ok || !snapshot.ok) throw new Error("fixture");
    const original = setup.brief.checks[0];
    if (!original) throw new Error("check");
    const check: typeof original = {
      ...original,
      command: [process.execPath, "--test", "--test-timeout", "5000", "test/value.test.mjs"],
      ...(declared ? { verifierFiles: ["test/value.test.mjs"] } : {}),
    };
    const digest = vi.spyOn(executables, "commandExecutableDigest");
    const result = await executeProductCheck(
      state,
      record.value,
      setup.brief.slices[0],
      check,
      "subject",
      false,
      snapshot.value,
    );
    expect(result.execution.status).toBe("failed");
    expect(digest).toHaveBeenCalledTimes(declared ? 2 : 0);
    expect(!!result.execution.commandVerifier).toBe(declared);
  },
);
