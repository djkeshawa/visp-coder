import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyFileTransaction,
  filePrecondition,
  inspectFileTransactions,
  recoverFileTransactions,
} from "../../../src/core/file-transaction.js";
import { ProjectFileSystem } from "../../../src/core/fs.js";
import { sha256 } from "../../../src/core/hash.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-assert-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it.each(["content", "mode", "link", "absence"])(
  "rejects a changed %s while planning an assertion",
  async (change) => {
    const path = join(root, "source");
    if (change !== "absence") await writeFile(path, "captured", { mode: 0o644 });
    const expectedBefore =
      change === "absence" ? filePrecondition(undefined) : filePrecondition("captured", 0o644);
    if (change === "content" || change === "absence") await writeFile(path, "edited");
    if (change === "mode") await chmod(path, 0o755);
    if (change === "link") {
      await rm(path);
      await symlink("captured", path);
    }
    expect(
      await applyFileTransaction(root, "assert-race", [
        { kind: "assert", path: "source", expectedBefore },
      ]),
    ).toMatchObject({
      ok: false,
      error: { message: "Concurrent change detected while planning source" },
    });
  },
);

it.each([false, true])(
  "leaves assertions untouched on rollback and recovery (interrupted=%s)",
  async (interrupted) => {
    await writeFile(join(root, "source"), "captured", { mode: 0o644 });
    await symlink("missing", join(root, "link"));
    const result = await applyFileTransaction(
      root,
      "assert-recovery",
      [
        { kind: "assert", path: "source", expectedBefore: filePrecondition("captured", 0o644) },
        { kind: "assert", path: "link", expectedBefore: filePrecondition("missing", 0o777, true) },
        { kind: "assert", path: "absent", expectedBefore: filePrecondition(undefined) },
        {
          kind: "write",
          path: "published",
          content: "new",
          expectedBefore: filePrecondition(undefined),
        },
      ],
      {
        leavePreparedOnError: interrupted,
        async afterMutation(applied) {
          if (applied !== 4) return;
          await writeFile(join(root, "source"), "user edit");
          await rm(join(root, "link"));
          await writeFile(join(root, "absent"), "user creation");
          throw new Error("interrupted");
        },
      },
    );
    expect(result.ok).toBe(false);
    if (interrupted) {
      const directory = join(root, ".visp/state/transactions");
      const names = await readdir(directory);
      const name = names[0];
      if (!name) throw new Error("Missing journal");
      const journal = JSON.parse(await readFile(join(directory, name), "utf8"));
      expect(journal.version).toBe(1);
      expect(journal.entries.slice(0, 3)).toEqual([
        { kind: "assert", path: "source", before: { ...filePrecondition("captured", 0o644) } },
        { kind: "assert", path: "link", before: { ...filePrecondition("missing", 0o777, true) } },
        { kind: "assert", path: "absent", before: { existed: false } },
      ]);
      expect(await inspectFileTransactions(root)).toMatchObject({
        ok: true,
        value: { pending: [journal.id] },
      });
      expect(await recoverFileTransactions(root)).toMatchObject({ ok: true, value: [journal.id] });
    }
    expect(await readFile(join(root, "source"), "utf8")).toBe("user edit");
    expect(await readFile(join(root, "absent"), "utf8")).toBe("user creation");
    await expect(readFile(join(root, "published"))).rejects.toThrow();
  },
);

it("rechecks assertions immediately before commit and rolls publication back", async () => {
  await writeFile(join(root, "source"), "captured", { mode: 0o644 });
  const result = await applyFileTransaction(
    root,
    "late-assert-race",
    [
      { kind: "assert", path: "source", expectedBefore: filePrecondition("captured", 0o644) },
      { kind: "write", path: "published", content: "new" },
    ],
    {
      async afterMutation(applied) {
        if (applied === 2) await writeFile(join(root, "source"), "late edit");
      },
    },
  );
  expect(result).toMatchObject({
    ok: false,
    error: { message: "Concurrent change detected before commit source" },
  });
  expect(await readFile(join(root, "source"), "utf8")).toBe("late edit");
  await expect(readFile(join(root, "published"))).rejects.toThrow();
});

it("counts no source writes for a successful assertion", async () => {
  await writeFile(join(root, "source"), "captured", { mode: 0o444 });
  const write = vi.spyOn(ProjectFileSystem.prototype, "writeBytesAtomic");
  expect(
    await applyFileTransaction(root, "assert-only", [
      { kind: "assert", path: "source", expectedBefore: filePrecondition("captured", 0o444) },
    ]),
  ).toMatchObject({ ok: true, value: { changed: 0 } });
  expect(write.mock.calls.some(([path]) => path === "source")).toBe(false);
});

it("bounds observation concurrency and selects planning errors in declared order", async () => {
  const mutations = [];
  for (let index = 0; index < 9; index++) {
    const path = `source-${index}`;
    await writeFile(join(root, path), index === 2 || index === 3 ? "edited" : "captured");
    mutations.push({ kind: "assert" as const, path, expectedBefore: filePrecondition("captured") });
  }
  const read = ProjectFileSystem.prototype.readBytesIfExists;
  let active = 0;
  let peak = 0;
  vi.spyOn(ProjectFileSystem.prototype, "readBytesIfExists").mockImplementation(async function (
    this: ProjectFileSystem,
    path,
  ) {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, path === "source-2" ? 10 : 1));
      return await read.call(this, path);
    } finally {
      active -= 1;
    }
  });
  expect(await applyFileTransaction(root, "ordered-assertions", mutations)).toMatchObject({
    ok: false,
    error: { message: "Concurrent change detected while planning source-2" },
  });
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
});

it("cleans a committed journal containing assertions without restoring sources or publication", async () => {
  await writeFile(join(root, "source"), "captured");
  await applyFileTransaction(
    root,
    "committed-assertion",
    [
      { kind: "assert", path: "source", expectedBefore: filePrecondition("captured") },
      { kind: "write", path: "published", content: "new" },
    ],
    {
      leavePreparedOnError: true,
      afterMutation(applied) {
        if (applied === 2) throw new Error("interrupted");
      },
    },
  );
  const directory = join(root, ".visp/state/transactions");
  const [name] = await readdir(directory);
  if (!name) throw new Error("Missing journal");
  const path = join(directory, name);
  const journal = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...journal, state: "committed" }));
  await writeFile(join(root, "source"), "user edit");
  expect(await recoverFileTransactions(root)).toMatchObject({ ok: true, value: [] });
  expect(await readFile(join(root, "source"), "utf8")).toBe("user edit");
  expect(await readFile(join(root, "published"), "utf8")).toBe("new");
});

it.each(["body", "missing-hash", "bad-hash", "post-image"])(
  "refuses an assertion journal with invalid %s",
  async (invalid) => {
    await writeFile(join(root, "source"), "captured");
    await applyFileTransaction(
      root,
      "invalid-assertion",
      [{ kind: "assert", path: "source", expectedBefore: filePrecondition("captured") }],
      {
        leavePreparedOnError: true,
        afterMutation() {
          throw new Error("interrupted");
        },
      },
    );
    const directory = join(root, ".visp/state/transactions");
    const [name] = await readdir(directory);
    if (!name) throw new Error("Missing journal");
    const path = join(directory, name);
    const journal = JSON.parse(await readFile(path, "utf8"));
    const entry = journal.entries[0];
    if (invalid === "body") entry.before.content = Buffer.from("captured").toString("base64");
    if (invalid === "missing-hash") delete entry.before.hash;
    if (invalid === "bad-hash") entry.before.hash = "invalid";
    if (invalid === "post-image") entry.afterHash = filePrecondition("captured").existed;
    await writeFile(path, JSON.stringify(journal));
    expect(await recoverFileTransactions(root)).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID" },
    });
  },
);

it("recovers a legacy version-one journal with source bodies", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const directory = join(root, ".visp/state/transactions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, "source"), "transaction", { mode: 0o644 });
  await writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      label: "legacy",
      createdAt: "2026-01-01T00:00:00Z",
      state: "prepared",
      entries: [
        {
          kind: "write",
          path: "source",
          before: {
            existed: true,
            content: Buffer.from("original").toString("base64"),
            hash: sha256(Buffer.from("original")),
            mode: 0o644,
          },
          afterHash: sha256(Buffer.from("transaction")),
          afterMode: 0o644,
        },
      ],
    }),
  );
  expect(await recoverFileTransactions(root)).toMatchObject({ ok: true, value: [id] });
  expect(await readFile(join(root, "source"), "utf8")).toBe("original");
});
