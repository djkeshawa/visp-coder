import { chmod, copyFile, lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { HOOK_TEMPLATE_VERSION } from "../../../src/harness/hooks.js";
import { readObservationViews } from "../../../src/workflow/evidence/observations.js";
import { loadWorkspace } from "../../../src/workflow/state.js";
import { TestProject } from "../support/project.js";

const FIXTURE = resolve(process.cwd(), "tests/fixtures/legacy-0.1.0");
const FEATURE = "001-legacy-login-evidence";

let project: TestProject | undefined;

afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

describe("VISP 0.1.0 project compatibility", () => {
  it("refuses retired configuration without rewriting the original project", async () => {
    project = await legacyProject();
    const before = await snapshotProject(project.root);
    const status = project.json("status");
    expect(status.envelope.error?.code).toBe("CONFIG_INVALID");
    expect(status.envelope.error?.message).toContain("context.snippetCap");
    expect(status.envelope.error?.message).toContain("graph.queryDepth");
    expect(status.envelope.error?.message).toContain("workflow.maxSourceFileLines");
    expect(status.envelope.error?.message).toContain("workflow.maxSourceLineChars");
    expect(status.envelope.error?.message).toContain("Remove this setting");
    expect(await snapshotProject(project.root)).toEqual(before);
  });

  it("reads legacy artifacts without migrating or reopening the completed feature", async () => {
    project = await legacyProject();
    await removeRetiredSettings(project);
    const before = await snapshotProject(project.root);

    const status = project.json<{ next: { action: string; command: string } }>("status");
    expect(status.result.exitCode).toBe(0);
    expect(status.envelope.data?.next).toMatchObject({ action: "understand" });
    expect(status.envelope.data?.next.command).toContain("migrate");
    const next = project.json<{ action: string; command: string }>("next");
    expect(next.result.exitCode).toBe(0);
    expect(next.envelope.data?.command).toContain("migrate");
    expect(project.run("migrate", "--dry-run").exitCode).toBe(0);

    const report = project.run("report", "--json");
    expect(report.exitCode).toBe(0);
    expect(await snapshotProject(project.root)).toEqual(before);

    const retiredMutations = [
      [
        "observe",
        "--task",
        "T001",
        "--criterion",
        "AC001",
        "--source",
        "manual",
        "--result",
        "satisfied",
        "--note",
        "Historical output",
      ],
      ["probe", "ingest", "--file", "not-read.json"],
    ];
    for (const args of retiredMutations) expect(project.run(...args).exitCode).not.toBe(0);
    expect(await snapshotProject(project.root)).toEqual(before);
    const originalFeature = await snapshotTree(join(project.root, ".visp/features"));
    expect(project.run("migrate").exitCode).toBe(0);
    const migratedBytes = await snapshotProject(project.root);
    for (const args of retiredMutations) expect(project.run(...args).exitCode).not.toBe(0);
    expect(await snapshotProject(project.root)).toEqual(migratedBytes);
    const afterMigration = await snapshotTree(join(project.root, ".visp/features"));
    for (const [path, entry] of Object.entries(originalFeature))
      expect(afterMigration[path]).toEqual(entry);
    expect(project.json<{ action: string }>("next").envelope.data?.action).toBe("complete");
    expect(project.json<{ state: { status: string } }>("status").envelope.data?.state.status).toBe(
      "historical-complete",
    );
    const loaded = await loadWorkspace(project.root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const observations = await readObservationViews(loaded.value, FEATURE, "T001");
    expect(observations.ok && observations.value).toMatchObject([
      {
        id: "OBS-00f497e1869c",
        stale: true,
        attachments: [
          {
            storedPath:
              ".visp/features/001-legacy-login-evidence/evidence/T001/observations/" +
              "OBS-00f497e1869c/attachments/01-legacy-login-observation.txt",
          },
        ],
      },
    ]);

    expect(
      await readFile(
        join(project.root, ".visp/features", FEATURE, "evidence/T001/probes.json"),
        "utf8",
      ),
    ).toContain("legacy-run-001");
  });

  it("upgrades generated assets explicitly while preserving all feature evidence", async () => {
    project = await legacyProject();
    await removeRetiredSettings(project);
    const featureBefore = await snapshotTree(join(project.root, ".visp/features"));

    const installed = project.run(
      "install",
      "--harness",
      "codex",
      "--profile",
      "minimal",
      "--hooks",
      "git",
      "--json",
    );
    expect(installed.exitCode, `${installed.stdout}\n${installed.stderr}`).toBe(0);
    expect(await snapshotTree(join(project.root, ".visp/features"))).toEqual(featureBefore);

    expect(await project.read("AGENTS.md")).toContain("<!-- visp:instructions:start -->");
    expect(await project.read(".visp/state/install.json")).toContain('"version": 1');
    const hook = await readFile(join(project.root, ".git/hooks/pre-commit"), "utf8");
    expect(hook).toContain(`hook-version: ${HOOK_TEMPLATE_VERSION}`);
    expect(hook).toContain("protocolVersion");

    const doctor = project.run("doctor", "--json");
    expect(doctor.exitCode).toBe(0);
  });
});

async function legacyProject(): Promise<TestProject> {
  const loaded = await TestProject.fromFixture(join(FIXTURE, "project"));
  // apply_patch (used to check in fixtures) normalizes the final newline. The
  // 0.1.0 skill asset intentionally had none, and its ownership fingerprint
  // depends on those exact bytes.
  const skill = join(loaded.root, ".agents/skills/visp/SKILL.md");
  const transportedSkill = await readFile(skill, "utf8");
  await writeFile(skill, transportedSkill.replace(/\n$/, ""), "utf8");
  const hook = join(loaded.root, ".git/hooks/pre-commit");
  await copyFile(join(FIXTURE, "generated/git-pre-commit"), hook);
  await chmod(hook, 0o755);
  return loaded;
}

async function snapshotProject(root: string): Promise<Record<string, SnapshotEntry>> {
  return snapshotTree(root, new Set([".git", ".bin"]));
}

interface SnapshotEntry {
  readonly mode: number;
  readonly bytes: string;
}

async function snapshotTree(
  root: string,
  excluded = new Set<string>(),
): Promise<Record<string, SnapshotEntry>> {
  const snapshot: Record<string, SnapshotEntry> = {};
  await walk(root);
  return snapshot;

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (excluded.has(path.split("/")[0] ?? "")) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const metadata = await lstat(absolute);
      snapshot[path] = {
        mode: metadata.mode & 0o777,
        bytes: (await readFile(absolute)).toString("base64"),
      };
    }
  }
}

/** Explicit operator preparation for 0.5; the checked-in old fixture stays intact. */
async function removeRetiredSettings(project: TestProject) {
  const original = await project.read("visp.yml");
  const config = parseDocument(original);
  for (const key of [
    "ranking",
    "snippetCap",
    "maxSnippetLines",
    "includeSnippets",
    "maxRegionsPerFile",
  ])
    config.deleteIn(["context", key]);
  config.deleteIn(["workflow", "maxSourceFileLines"]);
  config.deleteIn(["workflow", "maxSourceLineChars"]);
  config.deleteIn(["workflow", "requireTests"]);
  config.deleteIn(["graph", "queryDepth"]);
  config.deleteIn(["graph", "queryResults"]);
  await writeFile(join(project.root, "visp.yml"), config.toString());
}
