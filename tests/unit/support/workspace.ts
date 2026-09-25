import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { ok } from "../../../src/core/result.js";
import { defaultHooks, installHarness } from "../../../src/harness/install.js";
import { now } from "../../../src/workflow/artifacts/common.js";
import type { Plan, Requirement, Spec } from "../../../src/workflow/artifacts/feature.js";
import type { Task, TaskGraph } from "../../../src/workflow/artifacts/tasks.js";
import { runInit } from "../../../src/workflow/stages/init.js";
import { loadWorkspace, type WorkspaceState } from "../../../src/workflow/state.js";
import { buildContextPack } from "./legacy-context.js";

/**
 * A real `.visp/` in a real git repository, loaded in process.
 *
 * Functional tests drive the built CLI in a subprocess, which is the right way
 * to check what a user runs but leaves the branches inside verify, review and
 * doctor unexercised by anything that can be measured. These call the same code
 * directly, so the cases that only happen when something goes wrong — a command
 * that will not spawn, an unreadable manifest, a broken install — can be set up
 * deliberately.
 */
export class TestWorkspace {
  private constructor(
    readonly root: string,
    private readonly bin: string,
  ) {}

  static async create(
    files: Record<string, string | Uint8Array> = {},
    options: { critic?: boolean } = {},
  ): Promise<TestWorkspace> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "visp-workspace-")));
    const bin = await mkdtemp(join(tmpdir(), "visp-test-bin-"));
    const cli = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));
    const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    // Installed hooks must exercise this build, never an unrelated global VISP version.
    await writeFile(
      join(bin, "visp"),
      `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(cli)} "$@"\n`,
      { mode: 0o755 },
    );
    const workspace = new TestWorkspace(root, bin);

    await workspace.write("package.json", '{"name":"fixture"}\n');
    for (const [path, content] of Object.entries(files)) await workspace.write(path, content);

    workspace.git("init", "-b", "main");
    workspace.git("config", "user.email", "test@example.com");
    workspace.git("config", "user.name", "Test");
    workspace.commit("initial");

    const init = await runInit({ root, harness: "generic" });
    if (!init.ok) throw new Error(`init failed: ${init.error.message}`);
    // Baseline tests deliberately opt out of model review; critic tests opt into its default.
    if (!options.critic) {
      const config = parse(await readFile(join(root, "visp.yml"), "utf8"));
      config.critic = { ...config.critic, enabled: false };
      await workspace.write("visp.yml", stringify(config));
    }

    // init writes visp.yml and a .gitignore block. A user commits those before
    // starting work; leaving them dirty would make every verify report the
    // setup itself as an out-of-scope change.
    workspace.commit("add visp");

    return workspace;
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    const absolute = join(this.root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, typeof content === "string" ? "utf8" : undefined);
  }

  git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${this.bin}${delimiter}${process.env.PATH ?? ""}` },
    });
  }

  commit(message: string): void {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
  }

  async state(): Promise<WorkspaceState> {
    const loaded = await loadWorkspace(this.root);
    if (!loaded.ok) throw new Error(`load failed: ${loaded.error.message}`);
    return loaded.value;
  }

  /** Install the same instruction and refusal surfaces required by drafting stages. */
  async installFoundation(): Promise<void> {
    const state = await this.state();
    const installed = await installHarness(
      state.paths,
      {
        harness: state.config.harness,
        profile: state.config.profile,
        hooks: defaultHooks(state.config.harness),
        mcp: false,
      },
      { guardHandshake: async () => ok(undefined) },
    );
    if (!installed.ok) throw new Error(`install failed: ${installed.error.message}`);
  }

  /** A feature with a task graph, which is what verify and review judge against. */
  async withFeature(feature: string, tasks: readonly Partial<Task>[] = [task()]): Promise<void> {
    const state = await this.state();

    const wrote = await state.store.writeIntent({
      kind: "intent",
      createdAt: now(),
      id: feature,
      goal: "Do the thing",
      riskLevel: "low",
    });
    if (!wrote.ok) throw new Error(wrote.error.message);

    const graph: TaskGraph = {
      kind: "tasks",
      createdAt: now(),
      feature,
      tasks: tasks.map((overrides) => ({ ...task(), ...overrides }) as Task),
      draft: false,
    };
    const written = await state.store.writeTasks(graph);
    if (!written.ok) throw new Error(written.error.message);

    await state.store.writeStatus({
      kind: "status",
      createdAt: now(),
      updatedAt: now(),
      activeFeature: feature,
      activeTask: graph.tasks[0]?.id,
    });
  }

  /** A spec with acceptance criteria, which is what review now judges against. */
  async withSpec(feature: string, requirements: readonly Requirement[]): Promise<void> {
    const state = await this.state();
    const spec: Spec = {
      kind: "spec",
      createdAt: now(),
      feature,
      summary: "Do the thing well",
      researchFindings: [],
      requirements: [...requirements],
      qualityRequirements: [],
      behaviorScenarios: [],
      outOfScope: [],
      openQuestions: [],
      draft: false,
    };
    const written = await state.store.writeSpec(spec);
    if (!written.ok) throw new Error(written.error.message);
  }

  async withPlan(feature: string, newDependencies: readonly string[] = []): Promise<void> {
    const state = await this.state();
    const plan: Plan = {
      kind: "plan",
      createdAt: now(),
      feature,
      approach: "Do it carefully",
      researchFindings: [],
      decisions: [],
      modules: [],
      invariants: [],
      testStrategy: [],
      risks: [],
      newDependencies: [...newDependencies],
      draft: false,
    };
    const written = await state.store.writePlan(plan);
    if (!written.ok) throw new Error(written.error.message);
  }

  /** Give evidence tests the same compiled-context precondition as the real loop. */
  async ensureContext(feature: string, taskId = "T001"): Promise<void> {
    const state = await this.state();
    const graph = await state.store.readTasks(feature);
    if (!graph.ok) throw new Error(graph.error.message);
    const selected = graph.value.tasks.find((entry) => entry.id === taskId);
    if (!selected) throw new Error(`${taskId} is not in ${feature}`);
    const marker = await state.store.writeImplementMarker({
      kind: "implement-marker",
      createdAt: now(),
      feature,
      task: taskId,
      allowedFiles: selected.allowedFiles,
      expectedFiles: selected.expectedFiles,
      forbiddenFiles: selected.forbiddenFiles,
    });
    if (!marker.ok) throw new Error(marker.error.message);

    const pack = await state.store.readContextPack(feature, taskId);
    const manifest = await state.store.readContextManifest(feature, taskId);
    if (!pack.ok) throw new Error(pack.error.message);
    if (!manifest.ok) throw new Error(manifest.error.message);
    if (pack.value && manifest.value) return;

    const repositoryFiles = this.git("ls-files", "--cached", "--others", "--exclude-standard")
      .split("\n")
      .filter(Boolean)
      .sort();
    const built = await buildContextPack(state, { feature, taskId, repositoryFiles });
    if (!built.ok) throw new Error(built.error.message);
  }

  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    await rm(this.bin, { recursive: true, force: true });
  }
}

/** Minimal PNG header with real dimensions; enough for attachment metadata tests. */
export function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T001",
    title: "Change the auth module",
    description: "",
    taskClass: "feature",
    riskLevel: "low",
    status: "pending",
    requirements: [],
    qualityRequirements: [],
    scenarios: [],
    modules: [],
    dependsOn: [],
    allowedFiles: ["src/**/*.ts"],
    expectedFiles: ["src/app.ts"],
    forbiddenFiles: [],
    validationCommands: [],
    validationFiles: [],
    doneCriteria: [],
    ...overrides,
  } as Task;
}
