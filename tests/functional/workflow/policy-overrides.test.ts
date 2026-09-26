import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestProject } from "../support/project.js";

/**
 * Policy and overrides are how a project says which rules apply and records the
 * exceptions it makes. An exception nobody wrote down is indistinguishable from
 * a rule that was never enforced, so the record is the feature.
 */
describe("policy and overrides", () => {
  let project: TestProject;
  const feature = "001-scoped-work";

  beforeEach(async () => {
    project = await TestProject.create({
      "src/a/f.ts": "export const value = 1;\n",
      "src/b/g.ts": "export const other = 2;\n",
    });
    project.run("init", "--harness", "generic");
    project.run("install");
    project.commit("add visp");

    await project.seedHistoricalFeature(feature);
    await project.editArtifact(feature, "spec.json", (spec) => ({
      ...spec,
      summary: "Change only module a",
      requirements: [
        { id: "REQ001", statement: "Module a is updated", priority: "must", criteria: [] },
      ],
    }));

    await project.editArtifact(feature, "plan.json", (plan) => ({
      ...plan,
      approach: "Edit src/a only",
    }));

    await project.editArtifact(feature, "tasks.json", (graph) => ({
      ...graph,
      tasks: [
        {
          id: "T001",
          title: "Update module a",
          description: "",
          taskClass: "chore",
          riskLevel: "low",
          status: "pending",
          requirements: ["REQ001"],
          dependsOn: [],
          allowedFiles: ["src/a/**/*.ts"],
          expectedFiles: ["src/a/f.ts"],
          forbiddenFiles: [],
          validationCommands: [],
          doneCriteria: [],
        },
      ],
    }));
  });

  afterEach(async () => {
    await project.destroy();
  });

  it("records an override with a reason and an expiry", () => {
    const result = project.run(
      "override",
      "create",
      "evidence.test-signal",
      "--reason",
      "This task only moves files and cannot carry a test",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("OV001");

    expect(project.run("override", "list").stdout).toContain("active");
  });

  it("requires a reason worth reading", () => {
    const result = project.run("override", "create", "evidence.test-signal", "--reason", "because");
    expect(result.exitCode).not.toBe(0);
  });

  it("refuses to override a rule that protects the boundary", () => {
    const result = project.run(
      "override",
      "create",
      "scope.forbidden-paths",
      "--reason",
      "Attempting to waive a rule that cannot be waived",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cannot be overridden");
  });

  it("resolves an override while live and restores the rule on revoke", () => {
    project.run("policy", "set-strictness", "strict");
    const active = () =>
      project
        .json<{ rules: { id: string; active: boolean }[] }>("policy", "show")
        .envelope.data?.rules.find((rule) => rule.id === "evidence.test-signal")?.active;
    expect(active()).toBe(true);
    project.run(
      "override",
      "create",
      "evidence.test-signal",
      "--reason",
      "Moving files only; the behaviour is unchanged and covered elsewhere",
    );
    expect(active()).toBe(false);
    project.run("override", "revoke", "OV001");
    expect(active()).toBe(true);
  });

  it("reports a revoked override rather than forgetting it", () => {
    project.run(
      "override",
      "create",
      "evidence.test-signal",
      "--reason",
      "A reason long enough to be evaluated later",
    );
    project.run("override", "revoke", "OV001");

    const result = project.run("override", "list");
    expect(result.stdout).toContain("OV001");
    expect(result.stdout).toContain("revoked");
  });

  /**
   * The learning loop, end to end: what verify and review keep running into
   * becomes a proposal, and stays a proposal until a human accepts it.
   */
  it("keeps historical failure patterns advisory until a policy decision is explicit", async () => {
    const patterns = {
      kind: "failure-patterns",
      createdAt: new Date().toISOString(),
      occurrences: [
        { code: "no-test-signal", feature: "001-x", task: "T001", at: new Date().toISOString() },
        { code: "no-test-signal", feature: "001-x", task: "T002", at: new Date().toISOString() },
      ],
    };
    await project.write(".visp/failure-patterns.json", `${JSON.stringify(patterns, null, 2)}\n`);

    const before = project.run("next");
    expect(before.stdout).toContain("migrate");

    // A proposal is not a gate: nothing was turned on by the counter alone.
    expect(project.run("policy", "show").stdout).toMatch(/off\s+evidence\.test-signal/);

    project.run("policy", "set", "evidence.test-signal", "on");
    expect(project.run("next").stdout).not.toContain("Seen more than once");
  });

  /**
   * A recorded decision can outlive the rule it names. Because every command
   * loads the policy first, a strict enum on the rule id meant one retired rule
   * made the whole project unusable — and with a zod dump, not an explanation.
   */
  it("keeps working when a recorded decision names a rule this visp retired", async () => {
    await project.write(
      ".visp/policy.json",
      `${JSON.stringify(
        {
          kind: "policy",
          createdAt: new Date().toISOString(),
          strictness: "standard",
          rules: { "evidence.retired-rule": true },
        },
        null,
        2,
      )}\n`,
    );

    const status = project.run("status");
    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toContain("Invalid policy.json");
  });

  it("reports the stale decision rather than acting on it", async () => {
    await project.write(
      ".visp/policy.json",
      `${JSON.stringify(
        {
          kind: "policy",
          createdAt: new Date().toISOString(),
          strictness: "standard",
          rules: { "evidence.retired-rule": true },
        },
        null,
        2,
      )}\n`,
    );

    const result = project.run("policy", "validate");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("evidence.retired-rule");
  });

  it("passes validate when every recorded decision still names a rule", () => {
    project.run("policy", "set", "evidence.test-signal", "on");

    const result = project.run("policy", "validate");
    expect(result.exitCode).toBe(0);
  });
});
