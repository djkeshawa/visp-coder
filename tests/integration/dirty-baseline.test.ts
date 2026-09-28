import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitWritable } from "../../src/core/git.js";
import { createProductFeature, updateProductBrief } from "../../src/workflow/product/index.js";
import { unchangedInheritedPaths } from "../../src/workflow/product/inherited-changes.js";
import { checkProductScope } from "../../src/workflow/product/scopes.js";
import { readProductRecord } from "../../src/workflow/product/store.js";
import { runProductWork } from "../../src/workflow/product/work.js";
import { TestWorkspace } from "../unit/support/workspace.js";

let project: TestWorkspace | undefined;
afterEach(async () => {
  if (!project) return;
  // Read-only Git metadata cannot be removed until it is writable again.
  execFileSync("chmod", ["-R", "u+w", join(project.root, ".git")]);
  await project.destroy();
});

// chmod-based read-only Git needs a non-root POSIX user.
const cannotRestrict = process.getuid?.() === 0 || process.platform === "win32";

async function cleanProject(): Promise<TestWorkspace> {
  project = await TestWorkspace.create({ "src/value.mjs": "export const value = 1;\n" });
  await project.installFoundation();
  project.commit("install foundation");
  return project;
}

/** A previous session's uncommitted work: one tracked edit and one new file. */
async function leaveEarlierWork(workspace: TestWorkspace): Promise<void> {
  await workspace.write("src/value.mjs", "export const value = 1.5;\n");
  await workspace.write("notes/earlier.md", "earlier session notes\n");
}

/** Codex's workspace-write sandbox: Git can read but never write. */
function makeGitReadOnly(workspace: TestWorkspace): void {
  execFileSync("chmod", ["-R", "a-w", join(workspace.root, ".git")]);
}

async function startWithScope(workspace: TestWorkspace) {
  const started = await createProductFeature(await workspace.state(), { goal: "Return two" });
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
          command: [process.execPath, "-e", "process.exit(0)"],
          outcomes: ["O001"],
          files: ["src/value.mjs"],
          environment: "node",
        },
      ],
      slices: [
        {
          id: "T001",
          goal: "Return the promised value",
          outcomes: ["O001"],
          scope: { allowed: ["src/value.mjs"], expected: ["src/value.mjs"], forbidden: [] },
          checks: ["C001"],
        },
      ],
    },
    reason: "Define the first usable behavior",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  return started.value;
}

async function scopeCheck(workspace: TestWorkspace) {
  const state = await workspace.state();
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  const slice = record.value.brief.slices[0];
  if (!slice) throw new Error("no slice");
  return checkProductScope(state, record.value, slice);
}

describe("a feature that starts on uncommitted earlier work", () => {
  it("still asks to commit when Git is writable", async () => {
    const workspace = await cleanProject();
    await leaveEarlierWork(workspace);
    expect(await gitWritable(workspace.root)).toBe(true);
    const started = await createProductFeature(await workspace.state(), { goal: "Return two" });
    expect(started.ok).toBe(false);
    expect(!started.ok && started.error.message).toContain("Git accepts writes here");
    expect(!started.ok && started.error.recovery).toContain("git add -A && git commit");
  });

  it.skipIf(cannotRestrict)(
    "starts when Git cannot be written and attributes only further changes to the feature",
    async () => {
      const workspace = await cleanProject();
      await leaveEarlierWork(workspace);
      makeGitReadOnly(workspace);
      expect(await gitWritable(workspace.root)).toBe(false);

      const started = await startWithScope(workspace);
      expect(started.inheritedChanges).toEqual(["notes/earlier.md", "src/value.mjs"]);
      expect(started.inheritedChangesNote).toContain("Never discard");
      const feature = started.brief.feature;
      const recorded = await readFile(
        join(workspace.root, `.visp/state/inherited-changes/${feature}.json`),
        "utf8",
      );
      expect(Object.keys(JSON.parse(recorded).files)).toEqual([
        "notes/earlier.md",
        "src/value.mjs",
      ]);

      expect((await runProductWork(await workspace.state(), { task: "T001" })).ok).toBe(true);
      // Unchanged inherited files, in or outside the slice scope, are nobody's change.
      expect((await scopeCheck(workspace)).ok).toBe(true);
      expect([...(await unchangedInheritedPaths(await workspace.state(), feature))].sort()).toEqual(
        ["notes/earlier.md", "src/value.mjs"],
      );

      // Changing an inherited file further makes it the feature's change.
      await workspace.write("notes/earlier.md", "earlier session notes, edited by the feature\n");
      const outside = await scopeCheck(workspace);
      expect(outside.ok).toBe(false);
      expect(!outside.ok && outside.error.code).toBe("SCOPE_VIOLATION");
      expect(!outside.ok && outside.error.message).toContain("notes/earlier.md");
      expect(!outside.ok && outside.error.message).not.toContain("src/value.mjs");
      expect([...(await unchangedInheritedPaths(await workspace.state(), feature))]).toEqual([
        "src/value.mjs",
      ]);
    },
  );

  it.skipIf(cannotRestrict)(
    "keeps working-tree guard checks to the feature's own changes",
    async () => {
      const workspace = await cleanProject();
      await leaveEarlierWork(workspace);
      makeGitReadOnly(workspace);
      await startWithScope(workspace);
      expect((await runProductWork(await workspace.state(), { task: "T001" })).ok).toBe(true);
      const cli = join(process.cwd(), "dist/cli.js");
      const guard = () => {
        let output: string;
        try {
          output = execFileSync(process.execPath, [cli, "guard", "--json"], {
            cwd: workspace.root,
            encoding: "utf8",
          });
        } catch (error) {
          // A refusal exits 1 and still prints its envelope.
          output = (error as { stdout: string }).stdout;
        }
        return JSON.parse(output).data as { checked: number; allowed: boolean };
      };
      expect(guard()).toMatchObject({ checked: 0, allowed: true });
      // A further change to an inherited file is the feature's, and is checked.
      await workspace.write("notes/earlier.md", "edited by the feature\n");
      expect(guard()).toMatchObject({ checked: 1, allowed: false });
    },
  );
});
