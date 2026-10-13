import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, it } from "vitest";
import { HARNESSES } from "../../../src/core/constants.js";
import { cliTranscript, GoldenProject, Recorder } from "./project.js";

/**
 * `visp install` for every host at one profile: the reply, then every file it wrote or changed
 * with its content (resident guides, VISP.commands.md, skills, hooks, host settings and MCP
 * registration), as one snapshot per host.
 */
export function installScenarios(profile: "standard" | "minimal"): void {
  let project: GoldenProject | undefined;
  afterEach(async () => {
    await project?.destroy();
    project = undefined;
  });

  it.each(HARNESSES)(`installs for %s (${profile})`, async (harness) => {
    project = await GoldenProject.create({ install: false });
    const run = new Recorder(project, `install/${profile}`);
    const args = ["install", "--harness", harness, "--profile", profile];
    const result = await project.cli(...args);
    const files = await changedFiles(project.root);
    const contents = await Promise.all(
      files.map(async (path) => {
        const absolute = join(project?.root ?? "", path);
        const mode = ((await stat(absolute)).mode & 0o111) !== 0 ? " (executable)" : "";
        return `=== ${path}${mode}\n${await readFile(absolute, "utf8")}`;
      }),
    );
    await run.save(`${harness}.txt`, [cliTranscript(args, result), ...contents].join("\n"));
  });
}

/** Files the install created or changed, VISP's own runtime state left out. */
async function changedFiles(root: string): Promise<string[]> {
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  const listed = status
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
  // Git lists an ignored directory once; its files are what the host reads.
  const files = (
    await Promise.all(
      listed.map(async (path) =>
        path.endsWith("/")
          ? (
              await readdir(join(root, path), { recursive: true, withFileTypes: true })
            )
              .filter((entry) => entry.isFile())
              .map((entry) => relative(root, join(entry.parentPath, entry.name)))
          : [path],
      ),
    )
  ).flat();
  // The Git hook lives inside .git, which status never lists.
  const hook = await stat(join(root, ".git/hooks/pre-commit")).catch(() => undefined);
  return [...files, ...(hook ? [".git/hooks/pre-commit"] : [])]
    .filter((path) => !/^\.visp\/(?:state|telemetry|session|graph|install)/.test(path))
    .sort();
}
