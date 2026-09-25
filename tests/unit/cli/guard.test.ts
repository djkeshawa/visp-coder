import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { EXIT, GUARD_PROTOCOL_VERSION } from "../../../src/core/constants.js";
import { applyFileTransaction } from "../../../src/core/file-transaction.js";
import { ok } from "../../../src/core/result.js";
import { runtimeIdentity } from "../../../src/core/version.js";
import { installHarness } from "../../../src/harness/install.js";
import type { ScopeViolation } from "../../../src/orchestrate/guard.js";
import { saveOverrides } from "../../../src/workflow/state.js";
import { TestWorkspace, task } from "../support/workspace.js";
import { runCli, runJson } from "./support/cli.js";
import { authorize, withProductFeature } from "./support/product-fixtures.js";

/**
 * `guard` is the mechanical scope check every hook and CI job calls, so its
 * refusals are the ones a change actually runs into. The cases worth holding
 * are the ones where it would be convenient to say yes: no authorization at
 * all, a blocked path, a scope that merely happened to be lying around.
 */

interface GuardData {
  protocolVersion: number;
  checked: number;
  allowed: boolean;
  violations: Array<
    ScopeViolation | { path: string; reason: "transaction-pending"; message: string }
  >;
  authorizedTasks: string[];
  committable?: string[];
}

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create({ "src/app.ts": "export const a = 1;\n" });
  const state = await workspace.state();
  // These exercise the guard command on deliberately invalid diffs, not commit hooks.
  const installed = await installHarness(
    state.paths,
    {
      harness: state.config.harness,
      profile: state.config.profile,
      hooks: [],
      mcp: false,
    },
    { guardHandshake: async () => ok(undefined) },
  );
  expect(installed.ok).toBe(true);
  workspace.commit("install guard fixture");
});

afterEach(async () => {
  await workspace.destroy();
});

function guard(...args: string[]) {
  return runJson<GuardData>(workspace.root, "guard", ...args);
}

describe("refusing a change", () => {
  it.each([{ flags: [] }, { flags: ["--staged"] }, { flags: ["--base", "HEAD~1"] }])(
    "refuses the protected source of a rename with %j",
    async ({ flags }) => {
      await workspace.write("private.ts", "export const secret = 1;\n");
      workspace.commit("protected source");
      await withProductFeature(workspace, "001-guard");
      await authorize(workspace, {
        feature: "001-guard",
        task: "T001",
        forbiddenFiles: ["private.ts"],
      });
      workspace.git("mv", "private.ts", "src/moved.ts");
      if (flags.includes("--base")) workspace.commit("rename");
      const { envelope, exitCode } = await guard(...flags);
      expect(exitCode).toBe(EXIT.refused);
      expect(envelope.data?.violations).toContainEqual(
        expect.objectContaining({ path: "private.ts", reason: "forbidden-file" }),
      );
    },
  );

  it("refuses every path when no task is authorized", async () => {
    const { envelope, exitCode } = await guard("--path", "src/app.ts");

    expect(exitCode).toBe(EXIT.refused);
    expect(envelope.ok).toBe(false);
    expect(envelope.data?.violations[0]?.reason).toBe("no-authorization");
    expect(envelope.data?.authorizedTasks).toEqual([]);
  });

  /** A refusal that does not say what to do next leaves the agent guessing. */
  it("names the command that would authorize one", async () => {
    const { stdout } = await runCli(workspace.root, "guard", "--path", "src/app.ts");

    expect(stdout).toContain("BEGIN_VISP_GUARD");
    expect(stdout).toContain("visp work --task <id>");
  });

  it("refuses a file outside the authorized task's allowed files", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001" });

    const { envelope, exitCode } = await guard("--path", "docs/guide.md");

    expect(exitCode).toBe(EXIT.refused);
    expect(envelope.data?.violations[0]?.reason).toBe("outside-allowed-files");
    expect(envelope.data?.violations[0]?.message).toContain("T001");
    expect(envelope.data?.authorizedTasks).toEqual(["T001"]);
  });

  /** Blocked paths are project-wide: a task cannot grant itself the secrets file. */
  it("refuses a blocked path even when the task's scope covers it", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001", allowedFiles: ["**/*"] });

    const { envelope } = await guard("--path", ".env");

    expect(envelope.data?.violations[0]?.reason).toBe("blocked-path");
    expect(envelope.data?.allowed).toBe(false);
  });

  it("refuses traversal disguised as a VISP state path", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001", allowedFiles: ["**/*"] });

    const { envelope, exitCode } = await guard("--path", ".visp/../src/app.ts");

    expect(exitCode).toBe(EXIT.refused);
    expect(envelope.data?.allowed).toBe(false);
    expect(envelope.data?.violations[0]?.reason).toBe("invalid-path");
  });

  it("refuses a file the task itself declared forbidden", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, {
      feature: "001-guard",
      task: "T001",
      allowedFiles: ["src/**/*.ts"],
      forbiddenFiles: ["src/legacy/**"],
    });

    const { envelope } = await guard("--path", "src/legacy/old.ts");

    expect(envelope.data?.violations[0]?.reason).toBe("forbidden-file");
  });

  it("reports every out-of-scope file, not just the first", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001" });

    const { envelope } = await guard("--path", "docs/a.md", "src/app.ts", "docs/b.md");

    expect(envelope.data?.checked).toBe(3);
    expect(envelope.data?.violations.map((violation) => violation.path)).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
  });
});

describe("allowing a change", () => {
  it("allows protocol installation for legacy features while refusing their edit authority", async () => {
    await workspace.withFeature("001-legacy", [task()]);
    const handshake = await guard("--handshake");
    expect(handshake.exitCode).toBe(EXIT.ok);
    expect(handshake.envelope.data).toMatchObject({ runtime: runtimeIdentity() });
    expect(handshake.envelope.data).toMatchObject({
      checked: 0,
      allowed: true,
      authorizedTasks: [],
    });
    const actual = await guard("--path", "src/app.ts");
    expect(actual.envelope.error?.code).toBe("MIGRATION_REQUIRED");
    expect(actual.exitCode).not.toBe(EXIT.ok);
  });

  it("passes a file inside the authorized scope", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001" });

    const { envelope, exitCode } = await guard("--path", "src/app.ts");

    expect(exitCode).toBe(EXIT.ok);
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.allowed).toBe(true);
    expect(envelope.data?.protocolVersion).toBe(GUARD_PROTOCOL_VERSION);
    expect(envelope.data?.authorizedTasks).toEqual(["T001"]);
  });

  it("reports protocol health without testing a synthetic path against active scope", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001" });

    const { envelope, exitCode } = await guard("--handshake");

    expect(exitCode).toBe(EXIT.ok);
    expect(envelope.data).toMatchObject({
      protocolVersion: GUARD_PROTOCOL_VERSION,
      checked: 0,
      allowed: true,
      violations: [],
      authorizedTasks: ["T001"],
    });
  });

  /**
   * The pre-commit hook runs on every commit, including work that has nothing
   * to do with visp. Refusing there would obstruct ordinary use of the repo.
   */
  it("passes with --if-authorized when nothing is authorized", async () => {
    const { envelope, exitCode } = await guard("--if-authorized", "--path", "docs/guide.md");

    expect(exitCode).toBe(EXIT.ok);
    expect(envelope.data?.checked).toBe(0);
    expect(envelope.data?.allowed).toBe(true);
  });

  it("fails closed while an interrupted transaction is pending", async () => {
    await applyFileTransaction(
      workspace.root,
      "interrupted-closure",
      [{ kind: "write", path: "partial.txt", content: "partial\n" }],
      {
        afterMutation() {
          throw new Error("simulated crash");
        },
        leavePreparedOnError: true,
      },
    );

    const { envelope, exitCode } = await guard("--if-authorized", "--path", "docs/guide.md");

    expect(exitCode).not.toBe(EXIT.ok);
    expect(envelope.ok).toBe(false);
    expect(envelope.data?.allowed).toBe(false);
    expect(envelope.data?.violations[0]?.reason).toBe("transaction-pending");
  });

  it("still refuses without --if-authorized, which is what CI asks", async () => {
    const { exitCode } = await guard("--path", "docs/guide.md");

    expect(exitCode).toBe(EXIT.refused);
  });

  /**
   * A recorded, expiring override of scope.allowed-files is a decision someone
   * made and signed; the mechanical check honours it so the escape hatch is
   * real rather than advisory.
   */
  it("honours a recorded override of scope.allowed-files", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001" });

    const state = await workspace.state();
    const saved = await saveOverrides(state.paths, [
      {
        id: "O001",
        rule: "scope.allowed-files",
        reason: "Migrating the docs alongside the code, agreed in review",
        scope: {},
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ]);
    if (!saved.ok) throw new Error(saved.error.message);

    const { envelope, exitCode } = await guard("--path", "docs/guide.md");

    expect(exitCode).toBe(EXIT.ok);
    expect(envelope.data?.allowed).toBe(true);
  });
});

describe("where the scope comes from", () => {
  it("rejects a scope source it does not implement", async () => {
    const { envelope, exitCode } = await guard("--scope", "vibes", "--path", "src/app.ts");

    expect(exitCode).toBe(EXIT.usage);
    expect(envelope.error?.code).toBe("UNSUPPORTED");
    expect(envelope.error?.recovery).toContain("--scope markers");
  });

  /**
   * The refusal this tool exists for: with no feature tied to the branch, CI is
   * asked to pick one rather than judging the diff against whichever graph
   * happened to be on disk.
   */
  it("refuses to guess a feature when the branch names none", async () => {
    await withProductFeature(workspace, "001-guard");

    const { envelope, exitCode } = await guard("--scope", "tasks", "--path", "src/app.ts");

    expect(exitCode).toBe(EXIT.missingState);
    expect(envelope.error?.code).toBe("NO_ACTIVE_FEATURE");
    expect(envelope.error?.recovery).toContain("--feature");
  });

  /** A fresh checkout has no markers, so CI can only ask the committed graph. */
  it("reads scope from the committed graph when asked for it by name", async () => {
    await withProductFeature(workspace, "001-guard");

    const { envelope, exitCode } = await guard(
      "--scope",
      "tasks",
      "--feature",
      "001-guard",
      "--path",
      "src/app.ts",
    );

    expect(exitCode).toBe(EXIT.ok);
    expect(envelope.data?.authorizedTasks).toEqual(["T001"]);
  });

  it("still refuses an out-of-scope file under --scope tasks", async () => {
    await withProductFeature(workspace, "001-guard");

    const { envelope, exitCode } = await guard(
      "--scope",
      "tasks",
      "--feature",
      "001-guard",
      "--path",
      "docs/guide.md",
    );

    expect(exitCode).toBe(EXIT.refused);
    expect(envelope.data?.violations[0]?.reason).toBe("outside-allowed-files");
  });
});

describe("work from a task that is already closed", () => {
  /**
   * `done` clears the marker while the work sits uncommitted. Telling the agent
   * to re-authorize a task that is already finished sends it in a circle, so
   * the refusal has to name what is really going on.
   */
  beforeEach(async () => {
    await withProductFeature(workspace, "001-guard", [task({ id: "T001", status: "done" })]);
  });

  it("says the files belong to a closed task rather than demanding a new one", async () => {
    const { envelope } = await guard("--path", "src/app.ts");

    expect(envelope.data?.committable).toEqual(["src/app.ts"]);

    const { stdout } = await runCli(workspace.root, "guard", "--path", "src/app.ts");
    expect(stdout).toContain("already closed");
  });

  it("allows them outright with --include-done, which is what the commit hook uses", async () => {
    const { envelope, exitCode } = await guard("--include-done", "--path", "src/app.ts");

    expect(exitCode).toBe(EXIT.ok);
    expect(envelope.data?.allowed).toBe(true);
  });

  /** --include-done widens the scope; it does not switch the check off. */
  it("does not let --include-done admit a file no task ever declared", async () => {
    const { exitCode, envelope } = await guard("--include-done", "--path", "docs/guide.md");

    expect(exitCode).toBe(EXIT.refused);
    expect(envelope.data?.committable).toEqual([]);
  });

  it("ignores a stale authorization whose slice is already closed", async () => {
    await authorize(workspace, { feature: "001-guard", task: "T001" });

    const ordinary = await guard("--path", "src/app.ts");
    expect(ordinary.exitCode).toBe(EXIT.refused);
    expect(ordinary.envelope.data?.authorizedTasks).toEqual([]);

    const hookMode = await guard("--if-authorized", "--include-done", "--path", "docs/guide.md");
    expect(hookMode.exitCode).toBe(EXIT.ok);
    expect(hookMode.envelope.data?.checked).toBe(0);
  });

  it("fails closed when the authored slice disappears without a validated revision", async () => {
    await authorize(workspace, { feature: "001-guard", task: "T001" });
    const state = await workspace.state();
    const path = state.paths.featureFile("001-guard", "brief.yaml");
    const current = await state.files.readText(path);
    if (!current.ok) throw new Error(current.error.message);
    const written = await state.files.writeTextAtomic(
      path,
      stringify({ ...parse(current.value), slices: [] }),
    );
    if (!written.ok) throw new Error(written.error.message);
    const { envelope, exitCode } = await guard("--if-authorized", "--path", "docs/guide.md");
    expect(exitCode).not.toBe(EXIT.ok);
    expect(envelope.error?.code).toBe("ARTIFACT_INVALID");
  });
});

describe("choosing what to check", () => {
  it("reads the working tree when given no paths", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001" });
    await workspace.write("src/app.ts", "export const a = 2;\n");

    const { envelope, exitCode } = await guard();

    expect(exitCode).toBe(EXIT.ok);
    expect(envelope.data?.checked).toBe(1);
  });

  /**
   * visp's own artifacts change on every command. Counting them would spend the
   * changed-file budget on the tool's bookkeeping and report the tool's writes
   * as the agent's change.
   */
  it("ignores its own state directory when reading a diff", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001" });

    const { stdout } = await runCli(workspace.root, "guard");

    expect(stdout).toContain("No changes to check.");
  });

  it("checks only what is staged with --staged", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001" });
    await workspace.write("docs/guide.md", "staged\n");
    workspace.git("add", "docs/guide.md");
    await workspace.write("src/app.ts", "export const a = 3;\n");

    const { envelope } = await guard("--staged");

    expect(envelope.data?.checked).toBe(1);
    expect(envelope.data?.violations[0]?.path).toBe("docs/guide.md");
  });

  it("checks a committed range with --base", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001" });
    await workspace.write("docs/guide.md", "committed\n");
    workspace.commit("add a doc");

    const { envelope, exitCode } = await guard("--base", "HEAD~1");

    expect(exitCode).toBe(EXIT.refused);
    expect(envelope.data?.violations.map((violation) => violation.path)).toContain("docs/guide.md");
  });

  it("reports a base that git cannot resolve instead of passing on an empty diff", async () => {
    await withProductFeature(workspace, "001-guard");
    await authorize(workspace, { feature: "001-guard", task: "T001" });

    const { envelope, exitCode } = await guard("--base", "no-such-ref");

    expect(exitCode).not.toBe(EXIT.ok);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBeDefined();
  });
});

describe("a project without visp", () => {
  it("refuses with the command that would set one up", async () => {
    const bare = await mkdtemp(join(tmpdir(), "visp-cli-guard-"));
    try {
      const { envelope, exitCode } = await runJson(bare, "guard", "--path", "src/app.ts");

      expect(exitCode).toBe(EXIT.missingState);
      expect(envelope.error?.code).toBe("NOT_INITIALIZED");
      expect(envelope.error?.recovery).toContain("init");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
