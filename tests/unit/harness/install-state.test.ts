import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFileSystem } from "../../../src/core/fs.js";
import { ProjectPaths } from "../../../src/core/paths.js";
import { readInstallState } from "../../../src/harness/install-state.js";

let root = "";

afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = "";
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
