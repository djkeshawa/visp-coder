import { afterEach, expect, it } from "vitest";
import {
  changesSince,
  repositoryFiles,
  stagedChanges,
  trackedFiles,
  workingTreeChanges,
} from "../../../src/core/git.js";
import { checkPaths } from "../../../src/orchestrate/guard.js";
import { TestWorkspace } from "../support/workspace.js";

const FEATURE = "001-review";
let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});
it("rejects renaming an out-of-scope source into allowed scope", async () => {
  workspace = await TestWorkspace.create({
    "protected.ts": "export const value = 1;\n",
    "src/keep.ts": "// keep\n",
  });
  workspace.git("mv", "protected.ts", "src/moved.ts");
  const staged = await stagedChanges(workspace.root);
  const working = await workingTreeChanges(workspace.root);
  workspace.commit("rename");
  const committed = await changesSince(workspace.root, "HEAD~1");
  for (const diff of [staged, working, committed]) {
    if (!diff.ok) throw new Error(diff.error.message);
    const violations = checkPaths(
      diff.value.files.map((f) => f.path),
      {
        blockedPaths: ["protected.ts"],
        markers: [
          {
            kind: "implement-marker",
            createdAt: new Date().toISOString(),
            feature: FEATURE,
            task: "T001",
            allowedFiles: ["src/**"],
            expectedFiles: [],
            forbiddenFiles: [],
          },
        ],
      },
    );
    expect
      .soft(
        violations.some((v) => v.path === "protected.ts"),
        diff.value.basis,
      )
      .toBe(true);
  }
});

it("preserves Unicode filenames in git change and repository parsing", async () => {
  workspace = await TestWorkspace.create({ "src/café.ts": "export const x = 1;\n" });
  await workspace.write("src/café.ts", "export const x = 2;\n");
  const diff = await workingTreeChanges(workspace.root);
  if (!diff.ok) throw new Error(diff.error.message);
  expect(diff.value.files.map((f) => f.path)).toContain("src/café.ts");
});

it("does not treat a literal arrow in an ordinary filename as a rename", async () => {
  workspace = await TestWorkspace.create();
  await workspace.write("blocked -> allowed.ts", "changed");
  const diff = await workingTreeChanges(workspace.root);
  if (!diff.ok) throw new Error(diff.error.message);
  expect(diff.value.files.map((f) => f.path)).toContain("blocked -> allowed.ts");
});

it.each(
  process.platform === "win32"
    ? ["café.ts", "two words.ts"]
    : [
        "café.ts",
        "two words.ts",
        "tab\tname.ts",
        "line\nname.ts",
        'quote"name.ts',
        "trailing .ts ",
      ],
)("preserves %j across Git listings and diff bases", async (path) => {
  workspace = await TestWorkspace.create({ [path]: "original" });
  const tracked = await trackedFiles(workspace.root);
  const listed = await repositoryFiles(workspace.root);
  expect(tracked.ok && tracked.value).toContain(path);
  expect(listed.ok && listed.value).toContain(path);
  await workspace.write(path, "changed");
  workspace.git("add", "--", path);
  const staged = await stagedChanges(workspace.root);
  const working = await workingTreeChanges(workspace.root);
  workspace.commit("change");
  const committed = await changesSince(workspace.root, "HEAD~1");
  for (const diff of [staged, working, committed]) {
    expect(diff.ok && diff.value.files).toContainEqual({ path, status: "modified" });
  }
});

it("consumes copy-source records without reporting the untouched source as deleted", async () => {
  workspace = await TestWorkspace.create({ "source.ts": "export const value = 1;\n" });
  await workspace.write("copy.ts", "export const value = 1;\n");
  await workspace.write("other.ts", "export const other = 2;\n");
  workspace.git("config", "diff.renames", "copies");
  workspace.git("add", "-A");
  const changes = await stagedChanges(workspace.root);
  expect(changes.ok && changes.value.files.map((f) => f.path)).toEqual(["copy.ts", "other.ts"]);
});
