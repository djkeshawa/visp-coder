import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productSliceSchema } from "../../../src/workflow/product/model.js";
import { productSkills } from "../../../src/workflow/product/skills.js";
import { loadWorkspace } from "../../../src/workflow/state.js";
import { TestProject } from "../support/project.js";

describe("bundled skill catalog", () => {
  let project: TestProject;

  beforeEach(async () => {
    project = await TestProject.create();
    project.run("init", "--harness", "generic");
  });

  afterEach(async () => {
    await project.destroy();
  });

  it("lists bundled metadata without seeding anything", () => {
    const { result, envelope } = project.json<{
      skills: Array<{
        id: string;
        version: string;
        description: string;
        stages: string[];
        contentHash: string;
      }>;
    }>("skill", "catalog");

    expect(result.exitCode).toBe(0);
    expect(envelope.data?.skills).toEqual([
      {
        id: "research-the-craft",
        version: "3.7.0",
        description: expect.stringContaining("Investigate load-bearing uncertainty"),
        stages: ["context", "implement"],
        contentHash: expect.stringMatching(/^[a-f0-9]{12}$/),
      },
    ]);
    expect(project.run("skill", "list").stdout).toContain("No skills yet");
  });

  it("shows bundled content without overwriting local work and supports explicit reviewed replacement", async () => {
    const local = "---\nname: research-the-craft\n---\nLocal procedure.\n";
    await project.write("local.md", local);
    expect(
      project.run(
        "skill",
        "import",
        "--id",
        "research-the-craft",
        "--file",
        "local.md",
        "--by",
        "local-author",
      ).exitCode,
    ).toBe(0);
    const before = project.run("skill", "show", "research-the-craft").stdout;
    const shown = project.json<{ summary: { id: string; version: string }; content: string }>(
      "skill",
      "catalog",
      "--show",
      "research-the-craft",
    );
    expect(shown.result.exitCode, shown.result.stdout + shown.result.stderr).toBe(0);
    expect(shown.envelope.data?.summary).toMatchObject({
      id: "research-the-craft",
      version: "3.7.0",
    });
    expect(shown.envelope.data?.content).toContain("current product brief");
    const text = project.run("skill", "catalog", "--show", "research-the-craft");
    expect(text.stdout.trimEnd()).toBe(shown.envelope.data?.content.trimEnd());
    expect(project.run("skill", "show", "research-the-craft").stdout).toBe(before);
    expect(await project.read(".visp/skills/research-the-craft/SKILL.md")).toBe(local);
    const unknown = project.run("skill", "catalog", "--show", "missing");
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stdout + unknown.stderr).toContain("No bundled skill named missing");
    const admitted = project.json<{ version: string }>(
      "skill",
      "admit",
      "research-the-craft",
      "--by",
      "reviewer",
    );
    expect(admitted.result.exitCode).toBe(0);
    const version = admitted.envelope.data?.version;
    if (!version) throw new Error("Missing original revision");
    const originalRevision = await project.read(
      `.visp/skills/research-the-craft/revisions/${version}.json`,
    );
    await project.write("updated.md", text.stdout);
    expect(
      project.run("skill", "retire", "research-the-craft", "--reason", "Review current bundle")
        .exitCode,
    ).toBe(0);
    const proposed = project.json<{ state: string }>(
      "skill",
      "propose",
      "--id",
      "research-the-craft",
      "--file",
      "updated.md",
      "--origin",
      "seeded",
      "--by",
      "reviewer",
    );
    expect(proposed.result.exitCode, proposed.result.stdout).toBe(0);
    expect(proposed.envelope.data?.state).toBe("proposed");
    expect(await project.read(`.visp/skills/research-the-craft/revisions/${version}.json`)).toBe(
      originalRevision,
    );
    expect(project.run("skill", "admit", "research-the-craft", "--by", "reviewer").exitCode).toBe(
      0,
    );
    expect(await project.read(".visp/skills/research-the-craft/SKILL.md")).toContain(
      "current product brief",
    );
  });

  it("seeds an inert proposal and still requires explicit admission", () => {
    const seeded = project.run("skill", "seed", "research-the-craft", "--by", "catalog-reviewer");

    expect(seeded.exitCode).toBe(0);
    expect(seeded.stdout).toContain("seeded proposal");
    expect(seeded.stdout).toContain("does nothing until someone admits it");

    const proposed = project.run("skill", "show", "research-the-craft").stdout;
    expect(proposed).toContain("research-the-craft — proposed, seeded");
    expect(proposed).not.toContain("Admitted by catalog-reviewer");

    const admitted = project.run(
      "skill",
      "admit",
      "research-the-craft",
      "--by",
      "catalog-reviewer",
    );
    expect(admitted.exitCode).toBe(0);
    expect(project.run("skill", "show", "research-the-craft").stdout).toContain(
      "Admitted by catalog-reviewer",
    );
  });

  it("delivers the admitted research skill in current product context", async () => {
    expect(project.run("skill", "seed", "research-the-craft", "--by", "reviewer").exitCode).toBe(0);
    const slice = productSliceSchema.parse({
      id: "T001",
      goal: "Resolve a repository uncertainty",
      scope: { allowed: ["src/**"] },
    });
    const read = async () => {
      const loaded = await loadWorkspace(project.root);
      if (!loaded.ok) throw new Error(loaded.error.message);
      return productSkills(loaded.value, slice);
    };
    expect(await read()).toMatchObject({ ok: true, value: { skills: [] } });
    expect(project.run("skill", "admit", "research-the-craft", "--by", "reviewer").exitCode).toBe(
      0,
    );
    const delivered = await read();
    expect(delivered).toMatchObject({
      ok: true,
      value: {
        skills: [
          expect.objectContaining({
            advisory: true,
            content: expect.stringContaining("current product brief"),
          }),
        ],
      },
    });
  });

  it("is idempotent when the catalog content already exists", () => {
    const first = project.run("skill", "seed", "research-the-craft", "--by", "catalog-reviewer");
    const second = project.run("skill", "seed", "research-the-craft", "--by", "someone-else");

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already exists unchanged");

    const { envelope } = project.json<{ skills: Array<{ id: string; proposedBy?: string }> }>(
      "skill",
      "list",
    );
    expect(envelope.data?.skills).toEqual([
      expect.objectContaining({ id: "research-the-craft", proposedBy: "catalog-reviewer" }),
    ]);
  });

  it("refuses a conflicting local skill without overwriting it", async () => {
    const local = `---\nname: research-the-craft\n---\n\nKeep this local skill.\n`;
    await project.write("local.md", local);
    expect(
      project.run(
        "skill",
        "import",
        "--id",
        "research-the-craft",
        "--file",
        "local.md",
        "--by",
        "local-author",
      ).exitCode,
    ).toBe(0);

    const seeded = project.run("skill", "seed", "research-the-craft", "--by", "catalog-reviewer");

    expect(seeded.exitCode).not.toBe(0);
    expect(seeded.stdout + seeded.stderr).toContain("different content");
    expect(await project.read(".visp/skills/research-the-craft/SKILL.md")).toBe(local);
  });

  it("refuses an unknown catalog id", () => {
    const result = project.run("skill", "seed", "not-in-the-catalog", "--by", "someone");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("No bundled skill named not-in-the-catalog");
  });
});
