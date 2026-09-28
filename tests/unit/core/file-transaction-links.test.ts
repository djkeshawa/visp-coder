import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  applyFileTransaction,
  filePrecondition,
  recoverFileTransactions,
} from "../../../src/core/file-transaction.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-link-transaction-"));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it.each(["write", "remove", "symlink"] as const)(
  "recovers an interrupted %s of a link without following it",
  async (kind) => {
    await writeFile(join(root, "target"), "untouched");
    await symlink("target", join(root, "link"));
    const mutation = {
      kind,
      path: "link",
      content: "replacement",
      expectedBefore: filePrecondition("target", 0o777, true),
    };
    expect(
      await applyFileTransaction(root, "link", [mutation], {
        afterMutation() {
          throw new Error("interrupted");
        },
        leavePreparedOnError: true,
      }),
    ).toMatchObject({ ok: false });
    expect(await recoverFileTransactions(root)).toMatchObject({ ok: true });
    expect((await lstat(join(root, "link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, "link"))).toBe("target");
    expect(await readFile(join(root, "target"), "utf8")).toBe("untouched");
  },
);

it("recovers a regular file replaced by a link", async () => {
  await writeFile(join(root, "file"), "original");
  expect(
    await applyFileTransaction(
      root,
      "link",
      [
        {
          kind: "symlink",
          path: "file",
          content: "missing",
          expectedBefore: filePrecondition("original"),
        },
      ],
      {
        afterMutation() {
          throw new Error("interrupted");
        },
        leavePreparedOnError: true,
      },
    ),
  ).toMatchObject({ ok: false });
  expect(await recoverFileTransactions(root)).toMatchObject({ ok: true });
  expect(await readFile(join(root, "file"), "utf8")).toBe("original");
});

it("requires a link precondition and refuses linked parents and managed state", async () => {
  await mkdir(join(root, "actual"));
  await symlink("actual", join(root, "parent"));
  for (const mutation of [
    { kind: "write" as const, path: "parent", content: "overwrite" },
    { kind: "symlink" as const, path: "parent/child", content: "missing" },
    { kind: "symlink" as const, path: ".visp/link", content: "missing" },
  ])
    expect(await applyFileTransaction(root, "unsafe-link", [mutation])).toMatchObject({
      ok: false,
    });
  expect(await readlink(join(root, "parent"))).toBe("actual");
});
