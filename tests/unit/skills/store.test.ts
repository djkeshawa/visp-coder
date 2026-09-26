import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FILE } from "../../../src/core/constants.js";
import type { SkillIndex, SkillRecord } from "../../../src/skills/schema.js";
import {
  parseSkill,
  readIndex,
  readSkillBody,
  skillPath,
  upsert,
} from "../../../src/skills/store.js";
import type { WorkspaceState } from "../../../src/workflow/state.js";

describe("parseSkill", () => {
  it("parses valid frontmatter and leaves the body intact", () => {
    const result = parseSkill("---\nname: example\n---\n\nDo the thing.\n");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter).toEqual({ name: "example" });
    expect(result.value.body).toBe("\nDo the thing.\n");
  });

  it("keeps a skill without frontmatter as an ordinary document", () => {
    const result = parseSkill("## Procedure\n\nDo the thing.\n");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter).toEqual({});
    expect(result.value.body).toContain("Do the thing.");
  });

  it("rejects malformed YAML frontmatter", () => {
    const result = parseSkill("---\nallowedFiles: [src/**\n---\n\nDo the thing.\n");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ARTIFACT_INVALID");
    expect(result.error.message).toContain("frontmatter");
  });
});

describe("skill index paths", () => {
  const temporaryRoots: string[] = [];
  const index: SkillIndex = {
    kind: "skills",
    createdAt: "2026-01-01T00:00:00.000Z",
    skills: [],
  };
  const record: SkillRecord = {
    id: "safe-skill",
    name: "Safe skill",
    description: "",
    state: "proposed",
    trust: "verified",
    origin: "seeded",
    derivedFrom: [],
    contentHash: "external-hash",
    createdAt: index.createdAt,
  };

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  async function createIndexSymlinkFixture(kind: "skills-root" | "index-file") {
    const projectRoot = await mkdtemp(join(tmpdir(), "visp-skill-index-project-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "visp-skill-index-external-"));
    temporaryRoots.push(projectRoot, externalRoot);

    const skillsPath = join(projectRoot, ".visp", "skills");
    const externalIndex = join(externalRoot, FILE.skills);
    const sentinel = `${JSON.stringify(index)}\n`;
    await writeFile(externalIndex, sentinel);
    await mkdir(skillsPath, { recursive: true });

    if (kind === "skills-root") {
      await rm(skillsPath, { force: true, recursive: true });
      await symlink(externalRoot, skillsPath);
    } else {
      await symlink(externalIndex, join(skillsPath, FILE.skills));
    }

    return {
      externalIndex,
      sentinel,
      state: { paths: { state: join(projectRoot, ".visp") } } as WorkspaceState,
    };
  }

  it("reads legacy verified labels conservatively without changing saved bytes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "visp-skill-legacy-project-"));
    temporaryRoots.push(projectRoot);
    const directory = join(projectRoot, ".visp", "skills");
    const path = join(directory, FILE.skills);
    const content = JSON.stringify({ ...index, skills: [record] });
    await mkdir(directory, { recursive: true });
    await writeFile(path, content);
    const state = { paths: { state: join(projectRoot, ".visp") } } as WorkspaceState;
    const read = await readIndex(state);
    expect(read.ok && read.value.skills[0]).toMatchObject({
      trust: "declared",
      evidence: {
        verification: { execution: "unknown" },
        provenance: "unknown",
        usefulness: "unmeasured",
        usefulnessBasis: "unknown",
      },
    });
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it.each([
    ["skills-root", "the skills root"],
    ["index-file", "the final index file"],
  ] as const)("refuses index reads and upserts through %s symlinks", async (kind, label) => {
    const fixture = await createIndexSymlinkFixture(kind);

    const read = await readIndex(fixture.state);
    expect(read.ok, `read through ${label}`).toBe(false);
    if (read.ok) return;
    expect(read.error.message).toContain("symlink");

    const inserted = await upsert(fixture.state, record);
    expect(inserted.ok, `upsert through ${label}`).toBe(false);
    expect(await readFile(fixture.externalIndex, "utf8")).toBe(fixture.sentinel);
  });
});

describe("skill paths", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  async function createSymlinkFixture(kind: "skills-root" | "skill-directory" | "skill-file") {
    const projectRoot = await mkdtemp(join(tmpdir(), "visp-skill-project-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "visp-skill-external-"));
    temporaryRoots.push(projectRoot, externalRoot);

    const externalSkill = join(externalRoot, "safe-skill");
    const externalFile = join(externalSkill, "SKILL.md");
    const original = "external sentinel\n";
    await mkdir(externalSkill, { recursive: true });
    await writeFile(externalFile, original);
    await mkdir(join(projectRoot, ".visp", "skills"), { recursive: true });

    const linkPath =
      kind === "skills-root"
        ? join(projectRoot, ".visp", "skills")
        : kind === "skill-directory"
          ? join(projectRoot, ".visp", "skills", "safe-skill")
          : join(projectRoot, ".visp", "skills", "safe-skill", "SKILL.md");
    if (kind === "skills-root") {
      await rm(linkPath, { force: true, recursive: true });
      await symlink(externalRoot, linkPath);
    } else if (kind === "skill-directory") {
      await symlink(externalSkill, linkPath);
    } else {
      await mkdir(join(projectRoot, ".visp", "skills", "safe-skill"), { recursive: true });
      await symlink(externalFile, linkPath);
    }

    return {
      externalFile,
      original,
      state: { paths: { state: join(projectRoot, ".visp") } } as WorkspaceState,
    };
  }

  it("resolves a valid id under .visp/skills", () => {
    const state = { paths: { state: "/tmp/visp-project/.visp" } } as WorkspaceState;

    expect(skillPath(state, "safe-skill")).toBe(
      "/tmp/visp-project/.visp/skills/safe-skill/SKILL.md",
    );
  });

  it("rejects an id before forming a path outside .visp/skills", async () => {
    const state = { paths: { state: "/tmp/visp-project/.visp" } } as WorkspaceState;
    const id = "../../escaped-skill";

    const read = await readSkillBody(state, id);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.message).toContain("Skill id");
    expect(() => skillPath(state, id)).toThrow();
  });

  it("allows a real directory and preserves a no-frontmatter skill", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "visp-skill-project-"));
    temporaryRoots.push(projectRoot);
    const state = { paths: { state: join(projectRoot, ".visp") } } as WorkspaceState;
    const content = "## Procedure\n\nDo the thing.\n";

    await mkdir(join(projectRoot, ".visp", "skills", "safe-skill"), { recursive: true });
    await writeFile(skillPath(state, "safe-skill"), content);

    const read = await readSkillBody(state, "safe-skill");
    expect(read.ok && read.value).toBe(content);
    const parsed = parseSkill(content);
    expect(parsed.ok && parsed.value.frontmatter).toEqual({});
  });

  it.each([
    ["skills-root", "the skills root"],
    ["skill-directory", "an individual skill directory"],
    ["skill-file", "the final skill file"],
  ] as const)("refuses reads through %s symlinks", async (kind, label) => {
    const fixture = await createSymlinkFixture(kind);

    const read = await readSkillBody(fixture.state, "safe-skill");
    expect(read.ok, `read through ${label}`).toBe(false);
    if (read.ok) return;
    expect(read.error.message).toContain("symlink");
    expect(await readFile(fixture.externalFile, "utf8")).toBe(fixture.original);
  });
});
