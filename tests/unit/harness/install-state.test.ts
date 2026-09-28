import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFileSystem } from "../../../src/core/fs.js";
import { ProjectPaths } from "../../../src/core/paths.js";
import { runtimeIdentity } from "../../../src/core/version.js";
import { installHarness } from "../../../src/harness/install.js";
import { readInstallState } from "../../../src/harness/install-state.js";
import { TestWorkspace } from "../support/workspace.js";

let root = "";

afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = "";
});

it("requires an explicit runtime replacement even with --force", async () => {
  const workspace = await TestWorkspace.create();
  try {
    await workspace.installFoundation();
    const state = await workspace.state();
    const installed = JSON.parse(await readFile(state.paths.installState, "utf8"));
    installed.runtime = {
      ...runtimeIdentity(),
      buildId: "aaaaaaaaaaaaaaaa",
      executable: "/old/visp.js",
    };
    const previous = `${JSON.stringify(installed)}\n`;
    await writeFile(state.paths.installState, previous);
    const refused = await installHarness(state.paths, { harness: installed.harness, force: true });
    expect(refused).toMatchObject({ ok: false, error: { code: "RUNTIME_MISMATCH" } });
    expect(await readFile(state.paths.installState, "utf8")).toBe(previous);
    const allowed = await installHarness(state.paths, {
      harness: installed.harness,
      force: true,
      replaceRuntime: true,
    });
    expect(allowed.ok).toBe(true);
  } finally {
    await workspace.destroy();
  }
});

describe("install state", () => {
  it("rejects an invalid persisted harness choice", async () => {
    root = await mkdtemp(join(tmpdir(), "visp-install-state-"));
    const paths = new ProjectPaths(root);
    const files = new ProjectFileSystem(root);
    await mkdir(join(root, ".visp/state"), { recursive: true });
    const written = await files.writeTextAtomic(
      paths.installState,
      '{"kind":"install-state","version":1,"harness":"unknown","profile":"minimal","hooks":[],"mcp":false}\n',
    );
    if (!written.ok) throw new Error(written.error.message);

    const result = await readInstallState(paths, files);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ARTIFACT_INVALID");
  });
});
