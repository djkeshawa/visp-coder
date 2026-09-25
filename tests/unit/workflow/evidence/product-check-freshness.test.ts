import { chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productCheckEnvironment } from "../../../../src/core/check-context.js";
import type { Result } from "../../../../src/core/result.js";
import { ok } from "../../../../src/core/result.js";
import * as version from "../../../../src/core/version.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { runProductDone, runProductVerify } from "../../../../src/workflow/product/evidence.js";
import type { ProductBrief } from "../../../../src/workflow/product/model.js";
import {
  productSourceDigest,
  productSourceSnapshot,
} from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const workspace of workspaces.splice(0)) await workspace.destroy();
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function fixture() {
  const ready = await productWorkspace();
  workspaces.push(ready.workspace);
  return ready;
}

describe("product check input freshness", () => {
  it("keeps evidence current across equivalent browser selectors but invalidates a different executable", async () => {
    const { workspace, brief } = await fixture();
    await workspace.write(".visp/browser-a", "browser-a");
    await workspace.write(".visp/browser-b", "browser-b");
    await chmod(join(workspace.root, ".visp/browser-a"), 0o700);
    await chmod(join(workspace.root, ".visp/browser-b"), 0o700);
    await symlink(
      join(workspace.root, ".visp/browser-a"),
      join(workspace.root, ".visp/google-chrome"),
    );
    vi.stubEnv("PATH", `${join(workspace.root, ".visp")}:${process.env.PATH}`);
    vi.stubEnv("CHROME_BIN", undefined);
    const state = await workspace.state();
    const original = value(await productSourceDigest(state, brief));
    const executed = await productCheckEnvironment(workspace.root, "C001");
    vi.stubEnv("CHROME_BIN", join(workspace.root, ".visp/browser-a"));
    expect(value(await productSourceDigest(state, brief))).toBe(original);
    expect(await productCheckEnvironment(workspace.root, "C001")).toEqual(executed);
    vi.stubEnv("CHROME_BIN", join(workspace.root, ".visp/browser-b"));
    expect(value(await productSourceDigest(state, brief))).not.toBe(original);
  });
  it("ignores shell bookkeeping but invalidates changed behavioral environment and executes that identity", async () => {
    const { workspace, brief } = await fixture();
    vi.stubEnv("VISP_TEST_SETTING", "expected");
    vi.stubEnv("SHLVL", "2");
    vi.stubEnv("CODEX_THREAD_ID", "actor-thread");
    vi.stubEnv("CODEX_SESSION_ID", "actor-session");
    const state = await workspace.state();
    const before = value(await productSourceDigest(state, brief));
    vi.stubEnv("SHLVL", "3");
    vi.stubEnv("_", "/a/different/invocation");
    vi.stubEnv("PWD", "/an/incidental/shell/location");
    vi.stubEnv("CODEX_THREAD_ID", "reviewer-thread");
    vi.stubEnv("CODEX_SESSION_ID", "reviewer-session");
    expect(value(await productSourceDigest(state, brief))).toBe(before);
    vi.stubEnv("VISP_TEST_SETTING", "changed");
    expect(value(await productSourceDigest(state, brief))).not.toBe(before);
    await workspace.write(
      "tests/environment.mjs",
      "import assert from 'node:assert/strict'; assert.equal(process.env.VISP_TEST_SETTING, 'changed'); for (const name of ['_', 'SHLVL', 'PWD', 'OLDPWD']) assert.equal(process.env[name], undefined);\n",
    );
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          checks: [
            {
              ...brief.checks[0],
              id: "C001",
              command: [process.execPath, "tests/environment.mjs"],
              files: ["tests/environment.mjs"],
            },
          ],
        },
        reason: "Exercise the normalized execution environment",
      }),
    );
    value(await runProductWork(await workspace.state()));
    expect(value(await runProductVerify(await workspace.state())).passed).toBe(true);
  });

  it("bounds ignored glob traversal instead of walking arbitrarily deep trees", async () => {
    const { workspace, brief } = await fixture();
    await workspace.write(`.visp/deep/${"d/".repeat(65)}check.mjs`, "check");
    const result = await productSourceSnapshot(await workspace.state(), {
      ...brief,
      checks: brief.checks.map((check) => ({ ...check, files: [".visp/deep/**/*.mjs"] })),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED", message: expect.stringContaining("input budget") },
    });
  });

  it("refuses oversized declared inputs before reading their contents", async () => {
    const { workspace, brief } = await fixture();
    const state = await workspace.state();
    const metadata = state.files.readMetadata.bind(state.files);
    vi.spyOn(state.files, "readMetadata").mockImplementation((path) =>
      path === ".visp/large.bin"
        ? Promise.resolve(ok({ type: "file", mode: 0o644, size: 65 * 1024 * 1024 }))
        : metadata(path),
    );
    const reads = vi.spyOn(state.files, "readBytesIfExists");
    const result = await productSourceSnapshot(state, {
      ...brief,
      checks: brief.checks.map((check) => ({ ...check, files: [".visp/large.bin"] })),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED", message: expect.stringContaining("input budget") },
    });
    expect(reads.mock.calls.some(([path]) => path === ".visp/large.bin")).toBe(false);
  });

  it("reruns a changed ignored check instead of closing from a previous pass", async () => {
    const { workspace, brief } = await fixture();
    await workspace.write(".visp/check.mjs", "process.exit(0);\n");
    const updated = value(
      await updateProductBrief(await workspace.state(), {
        reason: "Use declared local verifier",
        brief: {
          ...brief,
          checks: [
            {
              ...brief.checks[0],
              id: "C001",
              command: [process.execPath, ".visp/check.mjs"],
              files: [".visp/check.mjs"],
            },
          ],
          slices: brief.slices.map((slice) => ({
            ...slice,
            scope: { ...slice.scope, allowed: [...slice.scope.allowed, ".visp/check.mjs"] },
          })),
        },
      }),
    );
    const state = await workspace.state();
    value(await runProductWork(state));
    expect(value(await runProductVerify(await workspace.state())).passed).toBe(true);
    const before = value(await productSourceDigest(await workspace.state(), updated));
    await workspace.write(".visp/check.mjs", "process.exit(1);\n");
    expect(value(await productSourceDigest(await workspace.state()))).not.toBe(before);
    const done = value(await runProductDone(await workspace.state()));
    expect(done.closed).toBe(false);
    expect(done.executions).toEqual([expect.objectContaining({ check: "C001", status: "failed" })]);
  });

  it("hashes ignored glob inputs, exact missing inputs and pinned files, while excluding unrelated generated reports", async () => {
    const { workspace, brief } = await fixture();
    await workspace.write(".gitignore", "ignored/\n");
    await workspace.write("ignored/checks/one.mjs", "one");
    await workspace.write("ignored/oracle.mjs", "oracle");
    await workspace.write("ignored/verifier.mjs", "assertion helper");
    const contract: ProductBrief = {
      ...brief,
      checks: brief.checks.map((check) => ({
        ...check,
        files: ["ignored/checks/**/*.mjs", "ignored/missing.mjs"],
        verifierFiles: ["ignored/verifier.mjs"],
      })),
      acceptanceBaseline: [
        {
          command: [process.execPath, "ignored/oracle.mjs"],
          files: [{ path: "ignored/oracle.mjs", sha256: "a".repeat(64) }],
        },
      ],
    };
    const state = await workspace.state();
    const initial = value(await productSourceSnapshot(state, contract));
    expect(Object.keys(initial)).toEqual(
      expect.arrayContaining([
        "ignored/checks/one.mjs",
        "ignored/oracle.mjs",
        "ignored/missing.mjs",
        "ignored/verifier.mjs",
      ]),
    );
    const before = value(await productSourceDigest(state, contract));
    await workspace.write(".visp/reports/unused.json", "bookkeeping");
    expect(value(await productSourceDigest(state, contract))).toBe(before);
    await workspace.write("ignored/verifier.mjs", "changed assertion helper");
    expect(value(await productSourceDigest(state, contract))).not.toBe(before);
    await workspace.write("ignored/checks/two.mjs", "new input");
    expect(value(await productSourceDigest(state, contract))).not.toBe(before);
    await workspace.write("ignored/missing.mjs", "now exists");
    expect(value(await productSourceSnapshot(state, contract))["ignored/missing.mjs"]).not.toBe(
      initial["ignored/missing.mjs"],
    );
  });

  it("binds check reuse to configured commands and runtime without adding pseudo paths to scope", async () => {
    const { workspace, brief } = await fixture();
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    value(await runProductWork(await workspace.state()));
    expect(value(await runProductVerify(await workspace.state())).passed).toBe(true);
    const state = await workspace.state();
    const snapshot = value(await productSourceSnapshot(state, brief));
    const before = value(await productSourceDigest(state, brief));
    const changed: WorkspaceState = {
      ...state,
      config: {
        ...state.config,
        workflow: {
          ...state.config.workflow,
          validationCommands: [[process.execPath, "-e", "process.exit(1)"]],
        },
      },
    };
    const done = value(await runProductDone(changed));
    expect(done.closed).toBe(false);
    expect(done.executions).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "CONFIG_1", status: "failed" })]),
    );
    expect(value(await productSourceSnapshot(changed, brief))).toEqual(snapshot);
    vi.spyOn(version, "runtimeIdentity").mockReturnValue({
      version: "different",
      buildId: "changed",
      executable: "test",
    });
    expect(value(await productSourceDigest(state, brief))).not.toBe(before);
  });

  it("refuses declared inputs redirected outside the repository", async () => {
    const { workspace, brief } = await fixture();
    await symlink("/etc/passwd", join(workspace.root, ".visp/check.mjs"));
    const result = await productSourceSnapshot(await workspace.state(), {
      ...brief,
      checks: brief.checks.map((check) => ({ ...check, files: [".visp/check.mjs"] })),
    });
    expect(result).toMatchObject({ ok: false });
  });
});
