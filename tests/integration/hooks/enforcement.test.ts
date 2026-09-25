import { execFileSync } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_PROTOCOL_VERSION } from "../../../src/core/constants.js";
import {
  applyFileTransaction,
  recoverFileTransactions,
} from "../../../src/core/file-transaction.js";
import { runtimeIdentity } from "../../../src/core/version.js";
import { TestProject } from "../../functional/support/project.js";

/**
 * The generated hooks are shipped source: a syntax error or a wrong contract in
 * one of them silently disables enforcement, so they are executed here rather
 * than merely rendered.
 */
describe("generated hooks", () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await TestProject.create({
      "src/auth/login.ts": "export const login = () => null;\n",
    });
    project.run("init", "--harness", "generic");
    project.run("install", "--harness", "claude-code", "--hooks", "claude", "git");

    await project.installShim();

    project.commit("add visp");
    await setUpTask(project);
  });

  afterAll(async () => {
    await project.destroy();
  });

  function callPreToolUse(
    filePath: string,
    env: NodeJS.ProcessEnv = project.env(),
  ): Record<string, unknown> {
    // Absolute node, so a case that empties PATH still reaches the interpreter.
    const output = execFileSync(
      process.execPath,
      [join(project.root, ".visp/hooks/claude-pretooluse.mjs")],
      {
        cwd: project.root,
        input: JSON.stringify({ tool_input: { file_path: filePath } }),
        encoding: "utf8",
        env,
      },
    );
    return JSON.parse(output);
  }

  function decision(response: Record<string, unknown>): string {
    const output = response.hookSpecificOutput as Record<string, string>;
    return output.permissionDecision ?? "";
  }

  function callPreCommit(env: NodeJS.ProcessEnv): string {
    return execFileSync("/bin/sh", [join(project.root, ".git/hooks/pre-commit")], {
      cwd: project.root,
      encoding: "utf8",
      env,
    });
  }

  // Workers paraphrase requests; the host records the user's own words for `visp feature`.
  it("records each user prompt locally and registers for prompt events", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const prompt of ["first request", 'Build the "quoted"\nmulti-line request'])
      execFileSync(process.execPath, [join(project.root, ".visp/hooks/claude-pretooluse.mjs")], {
        cwd: project.root,
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }),
        env: { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
      });
    const recorded = (
      await readFile(join(project.root, ".visp/session/user-prompts.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).prompt);
    expect(recorded).toEqual(["first request", 'Build the "quoted"\nmulti-line request']);
    const settings = JSON.parse(
      await readFile(join(project.root, ".claude/settings.json"), "utf8"),
    );
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: expect.stringContaining("claude-pretooluse.mjs") }] },
    ]);
    expect(settings.hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: expect.stringContaining("claude-pretooluse.mjs"),
            timeout: 180,
          },
        ],
      },
    ]);
    const { rm } = await import("node:fs/promises");
    await rm(join(project.root, ".visp/session/user-prompts.jsonl"));
  });

  // Weak workers stopped with slices open; the Stop hook sends them back a few times.
  it("sends a stopping worker back to an unfinished feature at most three times", async () => {
    const stop = () =>
      execFileSync(process.execPath, [join(project.root, ".visp/hooks/claude-pretooluse.mjs")], {
        cwd: project.root,
        input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }),
        env: { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
        encoding: "utf8",
      });
    const first = JSON.parse(stop());
    expect(first).toMatchObject({ decision: "block", reason: expect.stringContaining("visp") });
    stop();
    stop();
    expect(stop()).toBe("");
    const { rm } = await import("node:fs/promises");
    await rm(join(project.root, ".visp/session/stop-blocks.json"));
  });

  // A worker hand-edited the brief, left it unreadable and abandoned the workflow.
  it("refuses agent edits of VISP state except drafts", () => {
    expect(decision(callPreToolUse(".visp/features/x/brief.yaml"))).toBe("deny");
    expect(decision(callPreToolUse(".visp/drafts/assessment.json"))).toBe("allow");
  });

  // A worker ran rm -rf .visp acceptance to get past a scope error it could not read.
  it("refuses shell commands that would delete VISP state and leaves others to the host", async () => {
    const shell = (command: string) =>
      execFileSync(process.execPath, [join(project.root, ".visp/hooks/claude-pretooluse.mjs")], {
        cwd: project.root,
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        env: { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
        encoding: "utf8",
      });
    expect(decision(JSON.parse(shell("rm -rf .visp acceptance")))).toBe("deny");
    expect(decision(JSON.parse(shell("git clean -fd")))).toBe("deny");
    expect(shell("python3 acceptance/x/test.py")).toBe("");
    expect(shell("git stash")).toBe("");
    const { readFile } = await import("node:fs/promises");
    const settings = JSON.parse(
      await readFile(join(project.root, ".claude/settings.json"), "utf8"),
    );
    expect(settings.hooks.PreToolUse).toContainEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: expect.stringContaining("claude-pretooluse.mjs") }],
    });
  });

  it.each(["missing", "different"])(
    "refuses an otherwise valid guard response with %s build identity",
    async (kind) => {
      const envelope = {
        command: "guard",
        ok: true,
        data: {
          protocolVersion: GUARD_PROTOCOL_VERSION,
          checked: 1,
          allowed: true,
          violations: [],
          authorizedTasks: ["T001"],
          ...(kind === "different"
            ? { runtime: { ...runtimeIdentity(), buildId: "0123456789abcdef" } }
            : {}),
        },
      };
      const env = await fakeGuardEnv(
        project,
        `.identity-${kind}`,
        `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`,
      );
      expect(decision(callPreToolUse("src/auth/login.ts", env))).toBe("deny");
      expect(() => callPreCommit(env)).toThrow();
    },
  );

  it("runs without a syntax error and allows an in-scope write", () => {
    expect(decision(callPreToolUse("src/auth/login.ts"))).toBe("allow");
  });

  /**
   * A broken install is not a scope violation. Denying is still right — a hook
   * that cannot check must not allow — but reporting it as an out-of-scope path
   * sends someone to edit allowedFiles to fix a missing binary.
   */
  it("names the install when it cannot run visp at all", () => {
    const response = callPreToolUse("src/auth/login.ts", {
      ...project.env(),
      PATH: "/nonexistent",
    });
    const output = response.hookSpecificOutput as Record<string, string>;

    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("could not check");
    expect(output.permissionDecisionReason).toContain("visp doctor");
    expect(output.permissionDecisionReason).not.toContain("outside the scope");
  });

  it("denies a write outside the task's scope", () => {
    const response = callPreToolUse("src/billing/invoice.ts");
    expect(decision(response)).toBe("deny");

    const output = response.hookSpecificOutput as Record<string, string>;
    expect(output.permissionDecisionReason).toContain("src/billing/invoice.ts");
  });

  it("denies a blocked path without suggesting a gate that would not help", () => {
    const response = callPreToolUse(".env");
    const output = response.hookSpecificOutput as Record<string, string>;

    expect(decision(response)).toBe("deny");
    expect(output.permissionDecisionReason).toContain("blocked");
    expect(output.permissionDecisionReason).not.toContain("gate implement");
  });

  it("denies traversal disguised as a VISP state write", () => {
    const response = callPreToolUse(".visp/../src/billing/invoice.ts");
    const output = response.hookSpecificOutput as Record<string, string>;

    expect(decision(response)).toBe("deny");
    expect(output.permissionDecisionReason).toContain("project-relative path");
  });

  it("allows a tool call that touches no file", () => {
    // Absolute node, so a case that empties PATH still reaches the interpreter.
    const output = execFileSync(
      process.execPath,
      [join(project.root, ".visp/hooks/claude-pretooluse.mjs")],
      {
        cwd: project.root,
        input: JSON.stringify({ tool_input: { command: "ls" } }),
        encoding: "utf8",
      },
    );
    expect(decision(JSON.parse(output))).toBe("allow");
  });

  it("refuses a commit whose staged files are out of scope", async () => {
    await project.write("src/billing/invoice.ts", "export const invoice = () => 1;\n");
    project.git("add", "src/billing/invoice.ts");

    expect(() =>
      execFileSync("git", ["commit", "-m", "out of scope"], {
        cwd: project.root,
        encoding: "utf8",
        env: project.env(),
      }),
    ).toThrow();

    project.git("reset", "-q");
  });

  it("fails closed when visp is unavailable and an authorization is active", () => {
    expect(() => callPreCommit({ ...project.env(), PATH: "/usr/bin:/bin" })).toThrow();
  });

  it("warns but allows an unchecked commit when no authorization is active", async () => {
    const markers = join(project.root, ".visp/state/product-authorizations");
    const parked = `${markers}.parked`;
    await rename(markers, parked);
    try {
      expect(callPreCommit({ ...project.env(), PATH: "/usr/bin:/bin" })).toBe("");
    } finally {
      await rename(parked, markers);
    }
  });

  it("fails closed on malformed guard output while authorization is active", async () => {
    const env = await malformedGuardEnv(project);

    expect(() => callPreCommit(env)).toThrow();
  });

  it("fails closed on an underspecified legacy guard envelope", async () => {
    const env = await fakeGuardEnv(
      project,
      ".old-bin",
      '#!/bin/sh\necho \'{"command":"guard","ok":true,"data":{"allowed":true}}\'\n',
    );

    expect(() => callPreCommit(env)).toThrow();
    const edit = callPreToolUse("src/auth/login.ts", env);
    expect(decision(edit)).toBe("deny");
    expect((edit.hookSpecificOutput as Record<string, string>).permissionDecisionReason).toContain(
      "could not check",
    );
  });

  it("fails closed when interrupted closure removed the marker before commit", async () => {
    const marker = ".visp/state/product-authorizations/001-scoped-work.json";
    const interrupted = await applyFileTransaction(
      project.root,
      "interrupted-task-closure",
      [{ kind: "remove", path: marker }],
      {
        afterMutation() {
          throw new Error("simulated process exit");
        },
        leavePreparedOnError: true,
      },
    );
    expect(interrupted.ok).toBe(false);
    try {
      expect(() => callPreCommit(project.env())).toThrow();
    } finally {
      const recovered = await recoverFileTransactions(project.root);
      expect(recovered.ok).toBe(true);
    }
  });

  it("allows an unchecked commit when only a stale done-task marker remains", async () => {
    await project.editArtifact("001-scoped-work", "product-state.json", (state) => ({
      ...state,
      slices: {
        ...(state.slices as Record<string, unknown>),
        T001: {
          ...(state.slices as Record<string, Record<string, unknown>>).T001,
          status: "closed",
        },
      },
    }));
    try {
      expect(callPreCommit({ ...project.env(), PATH: "/usr/bin:/bin" })).toBe("");
    } finally {
      await project.editArtifact("001-scoped-work", "product-state.json", (state) => ({
        ...state,
        slices: {
          ...(state.slices as Record<string, unknown>),
          T001: {
            ...(state.slices as Record<string, Record<string, unknown>>).T001,
            status: "in-progress",
          },
        },
      }));
    }
  });

  it.each([2, 99])(
    "fails closed on unrecognized state generation %i even for a closed slice",
    async (version) => {
      let original: Record<string, unknown> = {};
      await project.editArtifact("001-scoped-work", "product-state.json", (state) => {
        original = state;
        const slices = state.slices as Record<string, Record<string, unknown>>;
        return {
          ...state,
          version,
          slices: { ...slices, T001: { ...slices.T001, status: "closed" } },
        };
      });
      try {
        expect(() => callPreCommit({ ...project.env(), PATH: "/usr/bin:/bin" })).toThrow();
      } finally {
        await project.editArtifact("001-scoped-work", "product-state.json", () => original);
      }
    },
  );

  it("fails closed when a malformed guard follows missing product state", async () => {
    const path = join(project.root, ".visp/features/001-scoped-work/product-state.json");
    const parked = `${path}.parked`;
    await rename(path, parked);
    try {
      const env = await malformedGuardEnv(project);
      expect(() => callPreCommit(env)).toThrow();
    } finally {
      await rename(parked, path);
    }
  });
});

async function malformedGuardEnv(project: TestProject): Promise<NodeJS.ProcessEnv> {
  return fakeGuardEnv(project, ".bad-bin", "#!/bin/sh\necho not-json\n");
}

async function fakeGuardEnv(
  project: TestProject,
  directory: string,
  source: string,
): Promise<NodeJS.ProcessEnv> {
  const bin = join(project.root, directory);
  await mkdir(bin, { recursive: true });
  const fake = join(bin, "visp");
  await writeFile(fake, source, "utf8");
  await chmod(fake, 0o755);
  return { ...project.env(), PATH: `${bin}:/usr/bin:/bin` };
}

async function setUpTask(project: TestProject): Promise<void> {
  const feature = "001-scoped-work";
  expect(project.run("feature", "Scoped work").exitCode).toBe(0);
  await project.authorBrief(feature, {
    outcomes: [{ id: "O001", kind: "functional", statement: "Login returns a token" }],
    checks: [{ id: "C001", command: ["node", "--test"], outcomes: ["O001"] }],
    slices: [
      {
        id: "T001",
        goal: "Change the auth module",
        outcomes: ["O001"],
        scope: { allowed: ["src/auth/**/*.ts"] },
        checks: ["C001"],
      },
    ],
  });
  // Isolate hook/scope enforcement from the separately tested critic consultation.
  expect(project.run("critic", "--off").exitCode).toBe(0);
  const worked = project.run("work", "--task", "T001");
  expect(worked.exitCode, worked.stdout + worked.stderr).toBe(0);
}
