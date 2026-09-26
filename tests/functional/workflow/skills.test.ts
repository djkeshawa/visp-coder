import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestProject } from "../support/project.js";

describe("learned skill lifecycle", () => {
  let project: TestProject;
  const feature = "001-scoped-change";

  beforeEach(async () => {
    project = await TestProject.create({
      "src/auth/login.ts": "export const login = () => null;\n",
      "src/billing/invoice.ts": "export const invoice = () => null;\n",
    });
    project.run("init", "--harness", "generic");
    project.run("install");
    project.commit("add visp");

    await project.seedHistoricalFeature(feature);
    await project.editArtifact(feature, "spec.json", (spec) => ({
      ...spec,
      summary: "Change only the auth module",
      requirements: [
        { id: "REQ001", statement: "Login returns a token", priority: "must", criteria: [] },
      ],
    }));

    await project.editArtifact(feature, "tasks.json", (graph) => ({
      ...graph,
      draft: false,
      tasks: [
        ...["T001", "T002", "T003"].map((id) => ({
          ...taskShape(id),
          // Closed work, which is what a skill has to be able to point at.
          status: "done",
        })),
        // Two open tasks in different parts of the tree, so a trigger has
        // something to distinguish.
        taskShape("T004"),
        {
          ...taskShape("T005"),
          allowedFiles: ["src/billing/**"],
          expectedFiles: ["src/billing/invoice.ts"],
        },
      ],
    }));
  });

  function taskShape(id: string) {
    return {
      id,
      title: `Task ${id}`,
      description: "",
      taskClass: "feature",
      riskLevel: "low",
      status: "pending",
      requirements: ["REQ001"],
      dependsOn: [],
      allowedFiles: ["src/auth/**"],
      expectedFiles: ["src/auth/login.ts"],
      forbiddenFiles: [],
      validationCommands: [],
      doneCriteria: [],
    };
  }

  afterEach(async () => {
    await project.destroy();
  });

  async function propose(content: string, ...tasks: string[]) {
    await project.write("draft.md", content);
    return project.run(
      "skill",
      "propose",
      "--id",
      "regenerate-client",
      "--file",
      "draft.md",
      "--feature",
      feature,
      ...tasks.flatMap((task) => ["--from-task", task]),
    );
  }

  const ordinary = `---
name: regenerate-client
description: Regenerate the API client after touching the schema
---

## Procedure

Run the generator, then commit both files together.

## Verification

\`node --version\`
`;

  it("refuses a skill drawn from a single task", async () => {
    const result = await propose(ordinary, "T001");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("closed task");
  });

  it("refuses one that names work this project never finished", async () => {
    const result = await propose(ordinary, "T001", "T002", "T999");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("T999");
  });

  it("accepts one drawn from enough finished work, and leaves it inert", async () => {
    const proposed = await propose(ordinary, "T001", "T002", "T003");
    expect(proposed.exitCode).toBe(0);
    expect(proposed.stdout).toContain("does nothing until someone admits it");

    const listed = project.run("skill", "list");
    expect(listed.stdout).toContain("proposed");
    expect(listed.stdout).toContain("declared");
  });

  it("refuses an absolute path to a proposed SKILL.md", async () => {
    await project.write("absolute-skill.md", ordinary);

    const { result, envelope } = project.json(
      "skill",
      "propose",
      "--id",
      "absolute-skill",
      "--file",
      join(project.root, "absolute-skill.md"),
      "--origin",
      "seeded",
    );

    expect(result.exitCode).not.toBe(0);
    expect(envelope.error?.code).toBe("ARTIFACT_INVALID");
    expect(envelope.error?.recovery).toContain("project-relative");
    await expect(project.read(".visp/skills/absolute-skill/SKILL.md")).rejects.toThrow();
  });

  it("refuses a traversal id before writing outside the skills directory", async () => {
    await project.write("draft.md", ordinary);

    const result = project.run(
      "skill",
      "propose",
      "--id",
      "../../escaped-skill",
      "--file",
      "draft.md",
      "--origin",
      "seeded",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Skill id");
    await expect(project.read("escaped-skill/SKILL.md")).rejects.toThrow();
  });

  it("refuses malformed frontmatter instead of screening it as empty metadata", async () => {
    const result = await propose(
      `---
name: sneaky
allowedFiles: [src/**
---

## Procedure

Run the generator.
`,
      "T001",
      "T002",
      "T003",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("frontmatter");
    expect(project.run("skill", "list").stdout).not.toContain("regenerate-client");
  });

  it("refuses to propose through a symlinked skills root", async () => {
    const externalRoot = await mkdtemp(join(tmpdir(), "visp-skill-propose-external-"));
    const skillsPath = join(project.root, ".visp", "skills");
    const externalFile = join(externalRoot, "regenerate-client", "SKILL.md");
    const sentinel = "leave this external file alone\n";

    try {
      await mkdir(join(externalRoot, "regenerate-client"), { recursive: true });
      await writeFile(externalFile, sentinel);
      await rm(skillsPath, { force: true, recursive: true });
      await symlink(externalRoot, skillsPath);

      const result = await propose(ordinary, "T001", "T002", "T003");

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("symlink");
      expect(await readFile(externalFile, "utf8")).toBe(sentinel);
    } finally {
      await rm(externalRoot, { force: true, recursive: true });
    }
  });

  /** The containment rule: refused outright, not filed for someone to notice. */

  it("admits a proposal, recording who did it", async () => {
    await propose(ordinary, "T001", "T002", "T003");

    const admitted = project.run("skill", "admit", "regenerate-client", "--by", "someone");
    expect(admitted.exitCode).toBe(0);

    expect(project.run("skill", "show", "regenerate-client").stdout).toContain(
      "Admitted by someone",
    );
  });

  it("refuses to admit a proposal edited after it was proposed", async () => {
    const proposed = await propose(ordinary, "T001", "T002", "T003");
    expect(proposed.exitCode).toBe(0);

    await project.write(
      ".visp/skills/regenerate-client/SKILL.md",
      "---\nname: regenerate-client\n---\n\n## Procedure\n\nRun a different generator.\n",
    );

    const admitted = project.run("skill", "admit", "regenerate-client", "--by", "someone");
    expect(admitted.exitCode).not.toBe(0);
    expect(admitted.stdout + admitted.stderr).toContain("edited");
    expect(project.run("skill", "show", "regenerate-client").stdout).toContain("proposed");
  });

  it("refuses to admit through a symlinked skill directory", async () => {
    const proposed = await propose(ordinary, "T001", "T002", "T003");
    expect(proposed.exitCode).toBe(0);

    const externalRoot = await mkdtemp(join(tmpdir(), "visp-skill-admit-external-"));
    const skillDirectory = join(project.root, ".visp", "skills", "regenerate-client");
    const externalFile = join(externalRoot, "SKILL.md");

    try {
      await writeFile(externalFile, ordinary);
      await rm(skillDirectory, { force: true, recursive: true });
      await symlink(externalRoot, skillDirectory);

      const admitted = project.run("skill", "admit", "regenerate-client", "--by", "someone");

      expect(admitted.exitCode).not.toBe(0);
      expect(admitted.stdout + admitted.stderr).toContain("symlink");
      expect(project.run("skill", "show", "regenerate-client").stdout).toContain("proposed");
      expect(await readFile(externalFile, "utf8")).toBe(ordinary);
    } finally {
      await rm(externalRoot, { force: true, recursive: true });
    }
  });

  it("refuses to admit the same skill twice", async () => {
    await propose(ordinary, "T001", "T002", "T003");
    project.run("skill", "admit", "regenerate-client", "--by", "someone");

    const again = project.run("skill", "admit", "regenerate-client", "--by", "someone");
    expect(again.exitCode).not.toBe(0);
  });

  it("rechecks support before admitting a stale proposal", async () => {
    await propose(ordinary, "T001", "T002", "T003");
    await project.editArtifact(feature, "tasks.json", (graph) => ({
      ...graph,
      tasks: (graph.tasks as Record<string, unknown>[]).map((task) =>
        task.id === "T001" ? { ...task, status: "pending" } : task,
      ),
    }));
    const admitted = project.run("skill", "admit", "regenerate-client", "--by", "someone");
    expect(admitted.exitCode).not.toBe(0);
    expect(admitted.stdout + admitted.stderr).toMatch(/support|closed task/);
    expect(project.run("skill", "show", "regenerate-client").stdout).toContain("proposed");
  });

  it("keeps the record of one that was turned down", async () => {
    await propose(ordinary, "T001", "T002", "T003");
    project.run("skill", "reject", "regenerate-client", "--reason", "Too narrow to reuse");

    const listed = project.run("skill", "list");
    expect(listed.stdout).toContain("rejected");
    expect(listed.stdout).toContain("Too narrow to reuse");
  });

  it("notices an admitted skill being edited afterwards", async () => {
    await propose(ordinary, "T001", "T002", "T003");
    project.run("skill", "admit", "regenerate-client", "--by", "someone");

    expect(project.run("skill", "diff", "regenerate-client").stdout).toContain("unchanged");

    await project.write(".visp/skills/regenerate-client/SKILL.md", "# rewritten\n");
    expect(project.run("skill", "diff", "regenerate-client").stdout).toContain("edited");
  });

  /** A skill cannot outlive the evidence that justified it. */
  it("suspends a skill when the work it was drawn from stops being done", async () => {
    await propose(ordinary, "T001", "T002", "T003");
    project.run("skill", "admit", "regenerate-client", "--by", "someone");

    await project.editArtifact(feature, "tasks.json", (graph) => ({
      ...graph,
      tasks: (graph.tasks as Record<string, unknown>[]).map((task) => ({
        ...task,
        status: "pending",
      })),
    }));

    const listed = project.run("skill", "list");
    expect(listed.stdout).toContain("orphaned");
  });
});
