import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DERIVED_STATE_PATHS } from "../../../src/core/constants.js";
import { planDerivedStateIgnore } from "../../../src/core/derived-ignore.js";
import { applyFileTransaction } from "../../../src/core/file-transaction.js";
import { ProjectFileSystem } from "../../../src/core/fs.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("derived-state ignore migration", () => {
  it("adds the journal to an existing ignore without changing authored entries or duplicating it", async () => {
    root = await mkdtemp(join(tmpdir(), "visp-derived-ignore-"));
    execFileSync("git", ["init", "-q", root]);
    const journal = ".visp/telemetry.json.events/";
    const original = `# User choices\ncache/\n${DERIVED_STATE_PATHS.filter((path) => path !== journal).join("\n")}\n`;
    const path = join(root, ".gitignore");
    await writeFile(path, original);
    const files = new ProjectFileSystem(root);
    const planned = await planDerivedStateIgnore(files, root);
    if (!planned.ok || !planned.value) throw new Error("expected a planned update");
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await applyFileTransaction(root, "ignore-migration", [planned.value])).ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe(`${original}${journal}\n`);
    expect(
      execFileSync("git", ["check-ignore", `${journal}000000000001-event.json`], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ).toContain("telemetry.json.events/");
    expect(await planDerivedStateIgnore(files, root)).toEqual({ ok: true, value: undefined });
  });

  it("preserves a project-authored blanket ignore", async () => {
    root = await mkdtemp(join(tmpdir(), "visp-derived-ignore-"));
    const original = "# deliberately private\n.visp/\n";
    await writeFile(join(root, ".gitignore"), original);
    expect(await planDerivedStateIgnore(new ProjectFileSystem(root), root)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(original);
  });
});
