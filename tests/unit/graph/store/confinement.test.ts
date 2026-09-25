import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectFileSystem } from "../../../../src/core/fs.js";
import { openProjectStore } from "../../../../src/graph/store/index.js";

let directory = "";
let project = "";
let outside = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "visp-graph-boundary-"));
  project = join(directory, "project");
  outside = join(directory, "outside");
  await mkdir(project);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel.txt"), "unchanged", "utf8");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("project graph store confinement", () => {
  it("creates a graph only at a validated project path", async () => {
    const path = join(project, ".visp", "graph", "graph.db");
    const opened = await openProjectStore(new ProjectFileSystem(project), path, {
      writable: true,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.value.close();

    const reopened = await openProjectStore(new ProjectFileSystem(project), path);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) reopened.value.close();
  });

  it("rejects a graph path under a symlinked managed parent", async () => {
    await symlink(outside, join(project, ".visp"), "dir");

    const opened = await openProjectStore(
      new ProjectFileSystem(project),
      join(project, ".visp", "graph", "graph.db"),
      { writable: true },
    );

    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.message).toContain("symlink");
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("unchanged");
  });

  it("rejects chained and dangling symlink components", async () => {
    await mkdir(join(project, ".visp"));
    await symlink(join(project, "second-link"), join(project, ".visp", "graph"), "dir");
    await symlink(outside, join(project, "second-link"), "dir");
    await symlink(join(project, "missing"), join(project, ".visp", "dangling"), "dir");
    const files = new ProjectFileSystem(project);

    const chained = await openProjectStore(files, join(project, ".visp", "graph", "graph.db"), {
      writable: true,
    });
    const dangling = await openProjectStore(files, join(project, ".visp", "dangling", "graph.db"), {
      writable: true,
    });

    expect(chained.ok).toBe(false);
    expect(dangling.ok).toBe(false);
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("unchanged");
  });

  it("rejects a symlinked SQLite companion before opening the database", async () => {
    const graphDirectory = join(project, ".visp", "graph");
    const path = join(graphDirectory, "graph.db");
    await mkdir(graphDirectory, { recursive: true });
    await symlink(join(outside, "sentinel.txt"), `${path}-wal`);

    const opened = await openProjectStore(new ProjectFileSystem(project), path, {
      writable: true,
    });

    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.message).toContain("symlink");
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("unchanged");
  });

  it("rejects traversal and outside absolute paths before SQLite opens them", async () => {
    const files = new ProjectFileSystem(project);
    const traversal = await openProjectStore(files, ".visp/graph/../escaped.db", {
      writable: true,
    });
    const absolute = await openProjectStore(files, join(outside, "external.db"), {
      writable: true,
    });

    expect(traversal.ok).toBe(false);
    expect(absolute.ok).toBe(false);
    await expect(readFile(join(outside, "external.db"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("unchanged");
  });
});
