import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * A throwaway git project with visp's built CLI pointed at it. Functional tests
 * drive the real binary, so they exercise what a user actually runs.
 */

const CLI = resolve(process.cwd(), "dist/cli.js");

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class TestProject {
  private constructor(readonly root: string) {}

  static async create(files: Record<string, string> = {}): Promise<TestProject> {
    const root = await mkdtemp(join(tmpdir(), "visp-functional-"));
    const project = new TestProject(root);

    await project.write(".gitignore", "node_modules/\n.bin/\n");
    await project.write("package.json", '{"name":"fixture","scripts":{"test":"node --test"}}\n');
    for (const [path, content] of Object.entries(files)) await project.write(path, content);

    project.git("init", "-b", "main");
    project.git("config", "user.email", "test@example.com");
    project.git("config", "user.name", "Test");
    project.commit("initial");
    await project.installShim();

    return project;
  }

  /** Loads a byte-for-byte project fixture before giving it a temporary Git repository. */
  static async fromFixture(fixtureRoot: string): Promise<TestProject> {
    const root = await mkdtemp(join(tmpdir(), "visp-functional-fixture-"));
    const project = new TestProject(root);

    await cp(fixtureRoot, root, { recursive: true });
    project.git("init", "-b", "main");
    project.git("config", "user.email", "test@example.com");
    project.git("config", "user.name", "Test");
    project.commit("legacy fixture", { skipHooks: true });
    await project.installShim();

    return project;
  }

  async write(path: string, content: string): Promise<void> {
    const absolute = join(this.root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  /** Reads a file from the project, for asserting on what visp wrote. */
  async read(path: string): Promise<string> {
    return readFile(join(this.root, path), "utf8");
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8", env: this.env() });
  }

  /**
   * Puts the project's own `.bin` first, so a hook calling `visp` reaches the
   * build under test rather than whatever is installed on the machine.
   */
  env(): NodeJS.ProcessEnv {
    return { ...process.env, PATH: `${join(this.root, ".bin")}:${process.env.PATH ?? ""}` };
  }

  /** Writes a `visp` shim into the project so installed hooks can run. */
  async installShim(): Promise<void> {
    const binDir = join(this.root, ".bin");
    await mkdir(binDir, { recursive: true });

    const shim = join(binDir, "visp");
    await writeFile(shim, `#!/bin/sh\nexec node ${CLI} "$@"\n`, "utf8");
    await chmod(shim, 0o755);
  }

  /**
   * `skipHooks` is for commits that are only setup for the assertion — getting
   * files tracked so a later command has something to read. Without it such a
   * commit is subject to the pre-commit hook, and the test then passes or fails
   * on whether a `visp` happened to be resolvable on the machine's PATH rather
   * than on what it meant to check.
   */
  commit(message: string, { skipHooks = false }: { skipHooks?: boolean } = {}): void {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message, ...(skipHooks ? ["--no-verify"] : []));
  }

  /** Runs the built CLI. A non-zero exit is returned, never thrown. */
  run(...args: string[]): RunResult {
    return this.runWithInput(undefined, ...args);
  }

  runWithInput(input: string | undefined, ...args: string[]): RunResult {
    try {
      const stdout = execFileSync("node", [CLI, "--project", this.root, ...args], {
        cwd: this.root,
        encoding: "utf8",
        input,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        // Same PATH the hooks get, so `doctor` sees the shim a user would have.
        env: this.env(),
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: Buffer; stderr?: Buffer; status?: number };
      return {
        stdout: failure.stdout?.toString() ?? "",
        stderr: failure.stderr?.toString() ?? "",
        exitCode: failure.status ?? 1,
      };
    }
  }

  /** Runs with `--json` and parses the envelope. `T` is the envelope's payload. */
  json<T>(...args: string[]): { result: RunResult; envelope: Envelope<T> } {
    const result = this.run(...args, "--json");
    if (!result.stdout.trim())
      throw new Error(
        `${args.join(" ")} returned no JSON (exit ${result.exitCode}): ${result.stderr}`,
      );
    return { result, envelope: JSON.parse(result.stdout) as Envelope<T> };
  }

  /** Rewrites a `.visp/` artifact, standing in for an agent filling it in. */
  async editArtifact(
    feature: string,
    name: string,
    edit: (value: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const path = join(".visp", "features", feature, name);
    const { readFile } = await import("node:fs/promises");
    const current = JSON.parse(await readFile(join(this.root, path), "utf8"));
    await this.write(path, `${JSON.stringify(edit(current), null, 2)}\n`);
  }

  /** Explicit historical fixtures exercise history/skill APIs without reviving removed commands. */
  async seedHistoricalFeature(feature: string): Promise<void> {
    const createdAt = new Date().toISOString();
    await this.write(
      `.visp/features/${feature}/intent.json`,
      JSON.stringify({
        kind: "intent",
        createdAt,
        id: feature,
        goal: "Historical scoped change",
        riskLevel: "low",
        researchRequired: false,
      }),
    );
    await this.write(
      `.visp/features/${feature}/spec.json`,
      JSON.stringify({
        kind: "spec",
        createdAt,
        feature,
        summary: "Historical scope",
        researchFindings: [],
        requirements: [],
        qualityRequirements: [],
        behaviorScenarios: [],
        outOfScope: [],
        openQuestions: [],
        draft: false,
      }),
    );
    await this.write(
      `.visp/features/${feature}/tasks.json`,
      JSON.stringify({ kind: "tasks", createdAt, feature, tasks: [], draft: false }),
    );
    await this.write(
      `.visp/features/${feature}/plan.json`,
      JSON.stringify({
        kind: "plan",
        createdAt,
        feature,
        approach: "Historical implementation",
        researchFindings: [],
        decisions: [],
        modules: [],
        invariants: [],
        testStrategy: [],
        risks: [],
        newDependencies: [],
        draft: false,
      }),
    );
    await this.write(
      ".visp/status.json",
      JSON.stringify({
        kind: "status",
        createdAt,
        updatedAt: createdAt,
        activeFeature: feature,
        activeTask: "T001",
      }),
    );
  }

  async compileHistoricalContext(feature: string, taskId = "T001"): Promise<void> {
    const { loadWorkspace } = await import("../../../src/workflow/state.js");
    const { buildContextPack } = await import("../../unit/support/legacy-context.js");
    const loaded = await loadWorkspace(this.root);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const built = await buildContextPack(loaded.value, {
      feature,
      taskId,
      repositoryFiles: this.git("ls-files", "--cached", "--others", "--exclude-standard")
        .split("\n")
        .filter(Boolean),
    });
    if (!built.ok) throw new Error(built.error.message);
  }

  /** Author the one current brief through the real CLI. */
  async authorBrief(
    feature: string,
    changes: Record<string, unknown>,
    reason = "Define the next observable behavior",
  ): Promise<void> {
    const current = this.json<Record<string, unknown>>("brief", "--feature", feature);
    if (!current.envelope.data) throw new Error(current.result.stdout + current.result.stderr);
    const updated = this.runWithInput(
      JSON.stringify({ ...current.envelope.data, ...changes }),
      "brief",
      "--feature",
      feature,
      "--from",
      "-",
      "--reason",
      reason,
    );
    if (updated.exitCode !== 0) throw new Error(updated.stdout + updated.stderr);
  }

  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

interface Envelope<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { code: string; message: string; recovery?: string };
  readonly nextCommand?: string;
}

export type { Envelope };
