import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestProject } from "../../functional/support/project.js";

/**
 * The pull-request surface, exercised against what CI actually has: the
 * committed trail and nothing else. A previous version of this workflow shipped
 * without such a test and could not pass at all — every file came back
 * unauthorized, because implement markers are per-worktree and never committed.
 */
describe("the pull request check", () => {
  let project: TestProject;
  const feature = "001-scoped-change";

  beforeEach(async () => {
    project = await TestProject.create({
      "src/auth/login.ts": "export const login = () => null;\n",
      "src/billing/invoice.ts": "export const invoice = () => null;\n",
    });
    project.run("init", "--harness", "generic");
    await project.installShim();
    project.run("install", "--hooks", "ci", "git");
    project.commit("add visp");

    project.run("feature", "Scoped change");
    await project.authorBrief(feature, {
      outcomes: [{ id: "O001", kind: "functional", statement: "Login returns a token" }],
      slices: [
        {
          id: "T001",
          goal: "Change only the auth module",
          outcomes: ["O001"],
          scope: { allowed: ["src/auth/**/*.ts"], expected: ["src/auth/login.ts"] },
          checks: [],
        },
      ],
    });
  });

  afterEach(async () => {
    await project.destroy();
  });

  /**
   * A pull request: the base is where the feature branched from, the change and
   * its declarations are committed on top, and everything a clone would not
   * receive is gone. Markers and status are per-developer and never committed.
   */
  async function asPullRequest(): Promise<string> {
    const base = project.git("rev-parse", "HEAD").trim();
    project.commit("the change, and the scope it declared");
    await rm(join(project.root, ".visp/state"), { recursive: true, force: true });
    await rm(join(project.root, ".visp/status.json"), { force: true });
    return base;
  }

  it("generates a workflow pinned to the package version", async () => {
    const workflow = await project.read(".github/workflows/visp.yml");
    const { version } = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    );

    expect(workflow).toContain("--scope tasks");
    expect(workflow).toContain(`npm install -g visp-coder@${version}`);
    expect(workflow).not.toContain("visp gate");
  });

  it("passes for a change inside what the feature declared", async () => {
    await project.write("src/auth/login.ts", "export const login = () => 'token';\n");
    const base = await asPullRequest();

    const result = project.run("guard", "--base", base, "--scope", "tasks");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("in scope");
  });

  it("refuses a change outside it, with no markers anywhere", async () => {
    await project.write("src/billing/invoice.ts", "export const invoice = () => 1;\n");
    const base = await asPullRequest();

    const result = project.run("guard", "--base", base, "--scope", "tasks");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("src/billing/invoice.ts");
  });

  /**
   * The distinction that makes this surface work: markers say what one machine
   * may edit now, the graph says what the feature ever declared. Only the second
   * survives a clone.
   */
  it("would refuse the same in-scope change if it asked for markers", async () => {
    await project.write("src/auth/login.ts", "export const login = () => 'token';\n");
    const base = await asPullRequest();

    const result = project.run("guard", "--base", base, "--scope", "markers");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("No task is authorized");
  });

  it("names the feature to pass when the branch matches none", async () => {
    const base = await asPullRequest();
    project.git("checkout", "-q", "-b", "unrelated-branch");

    const result = project.run("guard", "--base", base, "--scope", "tasks");
    expect(result.stdout + result.stderr).toContain("--feature");
  });

  it("accepts the feature explicitly", async () => {
    await project.write("src/auth/login.ts", "export const login = () => 'token';\n");
    const base = await asPullRequest();
    project.git("checkout", "-q", "-b", "unrelated-branch");

    const result = project.run("guard", "--base", base, "--scope", "tasks", "--feature", feature);
    expect(result.exitCode).toBe(0);
  });

  /**
   * actions/checkout detaches HEAD for a pull_request event, so
   * `rev-parse --abbrev-ref HEAD` answers the literal string "HEAD" and no
   * feature can match it. Every earlier test here used a named branch, which is
   * why this shipped: the workflow would have failed on every real pull request.
   */
  it("resolves the feature from --branch when the checkout is detached", async () => {
    await project.write("src/auth/login.ts", "export const login = () => 'token';\n");
    const base = await asPullRequest();

    const branch = project.git("rev-parse", "--abbrev-ref", "HEAD").trim();
    project.git("checkout", "-q", "--detach", "HEAD");
    expect(project.git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");

    const without = project.run("guard", "--base", base, "--scope", "tasks");
    expect(without.exitCode).not.toBe(0);

    const withBranch = project.run("guard", "--base", base, "--scope", "tasks", "--branch", branch);
    expect(withBranch.exitCode).toBe(0);
  });

  it("tells you --branch exists when the checkout is detached", async () => {
    const base = await asPullRequest();
    project.git("checkout", "-q", "--detach", "HEAD");

    const result = project.run("guard", "--base", base, "--scope", "tasks");
    expect(result.stdout + result.stderr).toContain("--branch");
  });

  it("generates a workflow that passes the branch explicitly", async () => {
    const workflow = await project.read(".github/workflows/visp.yml");
    expect(workflow).toContain("--branch");
    expect(workflow).toContain("github.head_ref");
  });

  it("rejects a scope source it does not have", () => {
    const result = project.run("guard", "--scope", "vibes");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Unknown scope source");
  });
});
