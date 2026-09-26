import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestProject } from "../support/project.js";

/**
 * Doctor is the answer to "is this set up right, and what do I do about it".
 * A check that cannot determine its answer must not report health.
 */
describe("doctor", () => {
  let project: TestProject;

  beforeEach(async () => {
    project = await TestProject.create({
      "src/token.ts": "export function makeToken(u: string) {\n  return u;\n}\n",
    });
    // Hooks shell out to `visp`; without a shim they are installed but unrunnable,
    // which is a different report from the one these tests are about.
    await project.installShim();
    project.run("init", "--harness", "generic");
  });

  afterEach(async () => {
    await project.destroy();
  });

  it("explains effective settings through the built command without rewriting configuration", async () => {
    await project.write(
      "visp.yml",
      "harness: generic\ncontext:\n  maxSnippets: 7\ncritic:\n  enabled: false\n",
    );
    const before = await project.read("visp.yml");
    const result = project.json<{ settings: { ok: boolean; value: { settings: unknown[] } } }>(
      "doctor",
      "--settings",
    );
    expect(result.envelope.data?.settings.ok).toBe(true);
    expect(result.envelope.data?.settings.value.settings).toContainEqual(
      expect.objectContaining({ path: "context.maxSnippets", value: 7, source: "project" }),
    );
    expect(result.envelope.data?.settings.value.settings).toContainEqual(
      expect.objectContaining({
        path: "workflow.flipCheck",
        effect: "legacy-only",
        note: expect.stringContaining("historical telemetry"),
      }),
    );
    const text = project.run("doctor", "--settings");
    expect(text.stdout).toContain("context.maxSnippets = 7 (project");
    expect(text.stdout).toContain("No active feature");
    expect(await project.read("visp.yml")).toBe(before);
  });

  it("reports a fresh project as degraded until it is finished being set up", () => {
    const result = project.run("doctor");
    expect(result.stdout).toContain("degraded");
    expect(result.stdout).toContain("harness assets");
    expect(result.stdout).toContain("repository index");
  });

  it("runs an explicit smoke command through the verification subprocess", async () => {
    await project.write("smoke.mjs", "process.exit(0);\n");
    const passed = project.run("doctor", "--check-command", "node smoke.mjs");
    expect(passed.exitCode).toBe(0);
    expect(passed.stdout).toContain("validation smoke");
    await project.write("smoke.mjs", "process.exit(3);\n");
    const failed = project.run("doctor", "--check-command", "node smoke.mjs");
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout).toContain("exited 3");
  });

  it("names a command for each thing that needs doing", () => {
    const result = project.run("doctor");
    expect(result.stdout).toContain("To fix:");
    expect(result.stdout).toContain("visp install");
    expect(result.stdout).toContain("visp index");
  });

  it("repairs what it can and reports the state it leaves behind", () => {
    const result = project.run("doctor", "--fix");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Repaired:");
    expect(result.stdout).toContain("healthy");
  });

  it("is idempotent, so running it twice changes nothing", () => {
    project.run("doctor", "--fix");
    const second = project.run("doctor", "--fix");
    expect(second.stdout).toContain("healthy");
  });

  /**
   * The point of the check: a project where nothing refuses anything must not
   * read as healthy, however complete the rest of the setup is.
   */

  it("notices the edit hook being unwired from settings, and rewires it", async () => {
    project.run("install", "--harness", "claude-code");
    await project.write(".claude/settings.json", "{}\n");

    const broken = project.run("doctor");
    expect(broken.stdout).toContain("not wired into settings");

    project.run("doctor", "--fix");
    expect(project.run("doctor").stdout).toContain("Refusals are enforced by");
  });

  /** An asset visp wrote and has since changed the template for is not healthy. */

  it("reports its findings as structured data too", () => {
    const { envelope } = project.json<{
      runtime: { version: string; buildId: string; executable: string };
      verdict: string;
      checks: { name: string; status: string }[];
    }>("doctor");

    expect(envelope.ok).toBe(true);
    expect(envelope.data?.runtime.version).toMatch(/^\d+\.\d+\.\d+|dev$/);
    expect(envelope.data?.runtime.buildId).toMatch(/^[a-f0-9]{16}$/);
    expect(envelope.data?.runtime.executable).toContain("dist/cli.js");
    expect(envelope.data?.verdict).toBeTruthy();
    expect(envelope.data?.checks.length).toBeGreaterThan(4);
  });
});
