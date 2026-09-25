import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFileTransaction,
  filePrecondition,
  inspectFileTransactions,
  RecoveringProjectFileSystem,
  recoverFileTransactions,
} from "../../../src/core/file-transaction.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "visp-transaction-"));
  roots.push(created);
  return created;
}

describe("file transactions", () => {
  // Snapshot guards restate unchanged files. Rewriting them failed inside host sandboxes
  // that protect agent directories such as .agents/ (EROFS), and touched every file.
  it("treats a write of identical bytes as a checked no-op", async () => {
    const project = await root();
    const protectedDir = join(project, ".agents");
    await mkdir(protectedDir);
    await writeFile(join(protectedDir, "SKILL.md"), "unchanged\n");
    await chmod(join(protectedDir, "SKILL.md"), 0o444);
    await chmod(protectedDir, 0o555);
    const before = await stat(join(protectedDir, "SKILL.md"));
    try {
      const result = await applyFileTransaction(project, "guard-unchanged", [
        {
          kind: "write",
          path: ".agents/SKILL.md",
          content: "unchanged\n",
          mode: 0o444,
          expectedBefore: filePrecondition("unchanged\n", 0o444),
        },
        { kind: "write", path: "state.json", content: "{}\n" },
      ]);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect((await stat(join(protectedDir, "SKILL.md"))).mtimeMs).toBe(before.mtimeMs);
      expect(await readFile(join(project, "state.json"), "utf8")).toBe("{}\n");
    } finally {
      await chmod(protectedDir, 0o755);
    }
  });

  it("commits absolute targets addressed through the caller's root alias", async () => {
    const parent = await root();
    const actual = join(parent, "actual");
    const alias = join(parent, "alias");
    await mkdir(actual);
    await symlink(actual, alias, "dir");
    await writeFile(join(actual, "one.txt"), "before\n");

    const result = await applyFileTransaction(alias, "aliased-root", [
      { kind: "write", path: join(alias, "one.txt"), content: "after\n" },
      { kind: "write", path: join(await realpath(actual), "two.txt"), content: "created\n" },
    ]);

    expect(result.ok).toBe(true);
    expect(await readFile(join(actual, "one.txt"), "utf8")).toBe("after\n");
    expect(await readFile(join(alias, "two.txt"), "utf8")).toBe("created\n");
    expect(await inspection(alias)).toEqual({ pending: [], committed: [] });
  });

  it("recovers an interrupted alias transaction through the canonical root", async () => {
    const parent = await root();
    const actual = join(parent, "actual");
    const alias = join(parent, "alias");
    await mkdir(actual);
    await symlink(actual, alias, "dir");
    await writeFile(join(actual, "one.txt"), "before\n");

    const interrupted = await applyFileTransaction(
      alias,
      "aliased-interruption",
      [{ kind: "write", path: join(alias, "one.txt"), content: "partial\n" }],
      {
        leavePreparedOnError: true,
        afterMutation() {
          throw new Error("aliased process stopped");
        },
      },
    );

    expect(!interrupted.ok && interrupted.error.message).toContain("aliased process stopped");
    expect(await readFile(join(actual, "one.txt"), "utf8")).toBe("partial\n");
    expect((await inspection(alias)).pending).toHaveLength(1);
    expect((await recoverFileTransactions(await realpath(actual))).ok).toBe(true);
    expect(await readFile(join(alias, "one.txt"), "utf8")).toBe("before\n");
    expect(await inspection(alias)).toEqual({ pending: [], committed: [] });
  });

  it("keeps duplicate, outside, and nested symlink targets confined with a root alias", async () => {
    const parent = await root();
    const actual = join(parent, "actual");
    const alias = join(parent, "alias");
    const outside = join(parent, "outside.txt");
    await mkdir(actual);
    await symlink(actual, alias, "dir");
    await writeFile(outside, "untouched\n");
    await symlink(parent, join(actual, "nested"), "dir");

    const duplicate = await applyFileTransaction(alias, "aliased-duplicate", [
      { kind: "write", path: join(alias, "one.txt"), content: "one" },
      { kind: "write", path: join(await realpath(actual), "one.txt"), content: "two" },
    ]);
    expect(!duplicate.ok && duplicate.error.message).toContain("duplicate target");
    for (const path of [outside, join(alias, "nested", "outside.txt"), `${alias}/../outside.txt`]) {
      const refused = await applyFileTransaction(alias, "aliased-escape", [
        { kind: "write", path, content: "changed" },
      ]);
      expect(refused.ok).toBe(false);
    }
    expect(await readFile(outside, "utf8")).toBe("untouched\n");
    await expect(readFile(join(actual, "one.txt"), "utf8")).rejects.toThrow();
    expect(await inspection(alias)).toEqual({ pending: [], committed: [] });
  });

  it("does not recover a transaction owned by another active writer", async () => {
    const project = await root();
    await writeFile(join(project, "one.txt"), "before\n");
    let paused!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const transaction = applyFileTransaction(
      project,
      "active",
      [
        { kind: "write", path: "one.txt", content: "after\n" },
        { kind: "write", path: "two.txt", content: "second\n" },
      ],
      {
        afterMutation: async (count) => {
          if (count === 1) {
            paused();
            await released;
          }
        },
      },
    );
    await entered;
    let otherFinished = false;
    const other = new RecoveringProjectFileSystem(project)
      .writeTextAtomic("other.txt", "other\n")
      .then((result) => {
        otherFinished = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const during = await readFile(join(project, "one.txt"), "utf8");
    resume();
    const results = await Promise.all([transaction, other]);
    expect(during).toBe("after\n");
    expect(results.every((result) => result.ok)).toBe(true);
    expect(otherFinished).toBe(true);
    expect(await readFile(join(project, "one.txt"), "utf8")).toBe("after\n");
  });

  it("rolls back bytes, modes, creations, and removals after a late failure", async () => {
    const project = await root();
    await writeFile(join(project, "kept.txt"), "before\n");
    await chmod(join(project, "kept.txt"), 0o600);
    await writeFile(join(project, "removed.txt"), "restore me\n");

    const result = await applyFileTransaction(
      project,
      "fault-test",
      [
        { kind: "write", path: "kept.txt", content: "after\n", mode: 0o755 },
        { kind: "write", path: "created.txt", content: "temporary\n" },
        { kind: "remove", path: "removed.txt" },
      ],
      {
        afterMutation(applied) {
          if (applied === 3) throw new Error("injected failure");
        },
      },
    );

    expect(result.ok).toBe(false);
    await expect(readFile(join(project, "kept.txt"), "utf8")).resolves.toBe("before\n");
    if (process.platform !== "win32") {
      expect((await stat(join(project, "kept.txt"))).mode & 0o777).toBe(0o600);
    }
    await expect(readFile(join(project, "removed.txt"), "utf8")).resolves.toBe("restore me\n");
    await expect(readFile(join(project, "created.txt"), "utf8")).rejects.toThrow();
    expect(await inspection(project)).toEqual({
      pending: [],
      committed: [],
    });
  });

  it("leaves a prepared journal recoverable after an interruption", async () => {
    const project = await root();
    await writeFile(join(project, "one.txt"), "one\n");

    const interrupted = await applyFileTransaction(
      project,
      "crash-test",
      [
        { kind: "write", path: "one.txt", content: "changed\n" },
        { kind: "write", path: "two.txt", content: "created\n" },
      ],
      {
        afterMutation(applied) {
          if (applied === 1) throw new Error("process stopped");
        },
        leavePreparedOnError: true,
      },
    );

    expect(interrupted.ok).toBe(false);
    await expect(readFile(join(project, "one.txt"), "utf8")).resolves.toBe("changed\n");
    expect((await inspection(project)).pending).toHaveLength(1);

    const recovered = await recoverFileTransactions(project);

    expect(recovered.ok).toBe(true);
    await expect(readFile(join(project, "one.txt"), "utf8")).resolves.toBe("one\n");
    await expect(readFile(join(project, "two.txt"), "utf8")).rejects.toThrow();
    expect(await inspection(project)).toEqual({
      pending: [],
      committed: [],
    });
  });

  it("recovers before the next mutation while keeping reads side-effect free", async () => {
    const project = await root();
    await writeFile(join(project, "one.txt"), "one\n");
    await applyFileTransaction(
      project,
      "interrupted",
      [{ kind: "write", path: "one.txt", content: "partial\n" }],
      {
        afterMutation() {
          throw new Error("process stopped");
        },
        leavePreparedOnError: true,
      },
    );
    const files = new RecoveringProjectFileSystem(project);

    const observed = await files.readText("one.txt");
    expect(observed.ok && observed.value).toBe("partial\n");
    expect((await inspection(project)).pending).toHaveLength(1);

    const written = await files.writeTextAtomic("next.txt", "next\n");
    expect(written.ok).toBe(true);
    await expect(readFile(join(project, "one.txt"), "utf8")).resolves.toBe("one\n");
    await expect(readFile(join(project, "next.txt"), "utf8")).resolves.toBe("next\n");
    expect((await inspection(project)).pending).toHaveLength(0);
  });

  it("preserves a divergent edit instead of overwriting it during recovery", async () => {
    const project = await root();
    await writeFile(join(project, "one.txt"), "before\n");
    await writeFile(join(project, "two.txt"), "before two\n");
    await applyFileTransaction(
      project,
      "interrupted",
      [
        { kind: "write", path: "one.txt", content: "transaction\n" },
        { kind: "write", path: "two.txt", content: "transaction two\n" },
      ],
      {
        afterMutation(applied) {
          if (applied === 2) throw new Error("process stopped");
        },
        leavePreparedOnError: true,
      },
    );
    await writeFile(join(project, "one.txt"), "external edit\n");

    const refused = await recoverFileTransactions(project);

    expect(refused.ok).toBe(false);
    await expect(readFile(join(project, "one.txt"), "utf8")).resolves.toBe("external edit\n");
    await expect(readFile(join(project, "two.txt"), "utf8")).resolves.toBe("transaction two\n");
    expect((await inspection(project)).pending).toHaveLength(1);

    await writeFile(join(project, "one.txt"), "transaction\n");
    const recovered = await recoverFileTransactions(project);

    expect(recovered.ok).toBe(true);
    await expect(readFile(join(project, "one.txt"), "utf8")).resolves.toBe("before\n");
    await expect(readFile(join(project, "two.txt"), "utf8")).resolves.toBe("before two\n");
    expect((await inspection(project)).pending).toHaveLength(0);
  });

  it("refuses a change made after planning but before journal preparation", async () => {
    const project = await root();
    await writeFile(join(project, "one.txt"), "planned value\n");
    const mutation = {
      kind: "write" as const,
      path: "one.txt",
      content: "transaction value\n",
      expectedBefore: filePrecondition("planned value\n"),
    };
    await writeFile(join(project, "one.txt"), "concurrent value\n");

    const refused = await applyFileTransaction(project, "concurrent-plan", [mutation]);

    expect(refused.ok).toBe(false);
    await expect(readFile(join(project, "one.txt"), "utf8")).resolves.toBe("concurrent value\n");
    expect(await inspection(project)).toEqual({ pending: [], committed: [] });
  });

  it("does not commit when an earlier target changes while later mutations run", async () => {
    const project = await root();
    await writeFile(join(project, "one.txt"), "before one\n");
    await writeFile(join(project, "two.txt"), "before two\n");

    const result = await applyFileTransaction(
      project,
      "late-concurrent-change",
      [
        { kind: "write", path: "one.txt", content: "after one\n" },
        { kind: "write", path: "two.txt", content: "after two\n" },
      ],
      {
        async afterMutation(applied) {
          if (applied === 2) await writeFile(join(project, "one.txt"), "external edit\n");
        },
      },
    );

    expect(result.ok).toBe(false);
    await expect(readFile(join(project, "one.txt"), "utf8")).resolves.toBe("external edit\n");
    await expect(readFile(join(project, "two.txt"), "utf8")).resolves.toBe("after two\n");
    expect((await inspection(project)).pending).toHaveLength(1);
  });

  it("rejects an untrusted journal path before it can reach an external file", async () => {
    const project = await root();
    const sentinelName = `visp-sentinel-${Date.now()}.txt`;
    const sentinel = join(project, "..", sentinelName);
    roots.push(sentinel);
    await writeFile(sentinel, "untouched\n");
    const id = "00000000-0000-4000-8000-000000000000";
    const directory = join(project, ".visp/state/transactions");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${id}.json`),
      JSON.stringify({
        version: 1,
        id,
        label: "malicious",
        createdAt: "2026-01-01T00:00:00.000Z",
        state: "prepared",
        entries: [{ kind: "remove", path: `../${sentinelName}`, before: { existed: false } }],
      }),
    );

    const refused = await recoverFileTransactions(project);

    expect(refused.ok).toBe(false);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("untouched\n");
  });

  it("refuses duplicate and non-file targets before writing a journal", async () => {
    const project = await root();
    await mkdir(join(project, "directory"));

    const duplicate = await applyFileTransaction(project, "duplicate", [
      { kind: "write", path: "same.txt", content: "one" },
      { kind: "write", path: "same.txt", content: "two" },
    ]);
    const directory = await applyFileTransaction(project, "directory", [
      { kind: "write", path: "directory", content: "no" },
    ]);

    expect(duplicate.ok).toBe(false);
    expect(directory.ok).toBe(false);
    expect(await inspection(project)).toEqual({
      pending: [],
      committed: [],
    });
  });
});

async function inspection(project: string) {
  const result = await inspectFileTransactions(project);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
