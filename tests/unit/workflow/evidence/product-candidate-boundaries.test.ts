import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vispError } from "../../../../src/core/errors.js";
import * as transactions from "../../../../src/core/file-transaction.js";
import { err, ok } from "../../../../src/core/result.js";
import {
  candidatePath,
  type ProductCandidate,
  prepareCandidate,
  readCandidate,
  restoreCandidate,
} from "../../../../src/workflow/product/candidate.js";
import {
  type CriticSelection,
  criticSelection,
} from "../../../../src/workflow/product/critic-store.js";
import { runProductWork } from "../../../../src/workflow/product/index.js";
import * as subjects from "../../../../src/workflow/product/subject.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
let state: WorkspaceState;
let selected: CriticSelection;
beforeEach(async () => {
  setup = await productWorkspace();
  state = await setup.workspace.state();
  await runProductWork(state, { task: "T001" });
  const result = await criticSelection(state, { task: "T001" });
  if (!result.ok) throw new Error("selection");
  selected = result.value;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setup.workspace.destroy();
});
async function preserve() {
  const prepared = await prepareCandidate(state, selected, {});
  if (!prepared.ok) throw new Error(prepared.error.message);
  expect(
    (
      await transactions.applyFileTransaction(
        state.paths.root,
        "candidate-test",
        prepared.value.mutations,
      )
    ).ok,
  ).toBe(true);
  return prepared.value.candidate;
}
async function currentSubject() {
  const subject = await subjects.productSourceDigest(state, selected.record.brief);
  if (!subject.ok) throw new Error(subject.error.message);
  return subject.value;
}
it("preserves missing tracked files and restores their absence", async () => {
  await rm(join(state.paths.root, "src/value.mjs"));
  const candidate = await preserve();
  expect(candidate.files.find((file) => file.path === "src/value.mjs")?.content).toBeNull();
  await setup.workspace.write("src/value.mjs", "temporary replacement");
  expect(
    await restoreCandidate(state, selected, candidate.id, await currentSubject()),
  ).toMatchObject({ ok: true });
  await expect(readFile(join(state.paths.root, "src/value.mjs"))).rejects.toThrow();
});
it("refuses malformed identities, paths, duplicate files and noncanonical encodings", async () => {
  const candidate = await preserve();
  const path = candidatePath(state, candidate.feature, candidate.id);
  const variants: ProductCandidate[] = [
    { ...candidate, root: "different-worktree" },
    { ...candidate, files: [...candidate.files, ...candidate.files] },
    {
      ...candidate,
      files: candidate.files.map((file, index) =>
        index === 0 ? { ...file, path: "../outside" } : file,
      ),
    },
    {
      ...candidate,
      files: candidate.files.map((file, index) =>
        index === 0 ? { ...file, content: "@@@" } : file,
      ),
    },
  ];
  for (const value of variants) {
    await writeFile(path, JSON.stringify(value));
    expect(await readCandidate(state, selected, candidate.id)).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID" },
    });
  }
  expect(await readCandidate(state, selected, "../../outside")).toMatchObject({ ok: false });
  await writeFile(path, "not JSON");
  expect(await readCandidate(state, selected, candidate.id)).toMatchObject({ ok: false });
  await rm(path);
  expect(await readCandidate(state, selected, candidate.id)).toMatchObject({ ok: false });
});
it("enforces bounds for source, serialized evidence, file count and saved records", async () => {
  expect(await prepareCandidate(state, selected, "x".repeat(32 * 1024 * 1024))).toMatchObject({
    ok: false,
    error: { code: "UNSUPPORTED" },
  });
  const candidate = await preserve();
  const path = candidatePath(state, candidate.feature, candidate.id);
  await writeFile(path, Buffer.alloc(32 * 1024 * 1024 + 1));
  expect(await readCandidate(state, selected, candidate.id)).toMatchObject({
    ok: false,
    error: { message: "Oversized candidate" },
  });
  await setup.workspace.write("src/huge.bin", Buffer.alloc(32 * 1024 * 1024 + 1));
  expect(await prepareCandidate(state, selected, {})).toMatchObject({
    ok: false,
    error: { code: "UNSUPPORTED" },
  });
  vi.spyOn(subjects, "productSourceSnapshot").mockResolvedValueOnce(
    ok(Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`file-${i}`, "hash"]))),
  );
  expect(await prepareCandidate(state, selected, {})).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("2000") },
  });
});
it("does not legitimize files changing between snapshot, metadata and capture reads", async () => {
  const snapshot = await subjects.productSourceSnapshot(state, selected.record.brief);
  vi.spyOn(subjects, "productSourceSnapshot").mockResolvedValue(snapshot);
  const original = state.files.readBytesIfExists.bind(state.files);
  vi.spyOn(state.files, "readBytesIfExists").mockImplementation(async (path) =>
    path === "src/value.mjs" ? ok(Buffer.from("changed after snapshot")) : original(path),
  );
  expect(await prepareCandidate(state, selected, {})).toMatchObject({
    ok: false,
    error: { code: "EVIDENCE_FAILED" },
  });
  vi.restoreAllMocks();
  vi.spyOn(subjects, "productSourceSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(state.files, "readBytesIfExists").mockImplementation(async (path) =>
    path === "src/value.mjs" ? ok(Buffer.alloc(32 * 1024 * 1024 + 1)) : original(path),
  );
  expect(await prepareCandidate(state, selected, {})).toMatchObject({
    ok: false,
    error: { code: "UNSUPPORTED" },
  });
});
it("propagates unavailable source, metadata and read failures before publishing a candidate", async () => {
  const failure = err(vispError("IO_ERROR", "fixture read unavailable"));
  vi.spyOn(subjects, "productSourceSnapshot").mockResolvedValueOnce(failure);
  expect(await prepareCandidate(state, selected, {})).toEqual(failure);
  vi.spyOn(state.files, "readMetadata").mockResolvedValueOnce(failure);
  expect(await prepareCandidate(state, selected, {})).toEqual(failure);
  vi.spyOn(state.files, "readBytesIfExists").mockResolvedValueOnce(failure);
  expect(await prepareCandidate(state, selected, {})).toEqual(failure);
  const candidate = await preserve();
  vi.spyOn(state.files, "readMetadata").mockResolvedValueOnce(failure);
  expect(await readCandidate(state, selected, candidate.id)).toEqual(failure);
});
it("requires an active selection and rejects restore plans that exceed its scope", async () => {
  const candidate = await preserve();
  expect(
    await restoreCandidate(
      state,
      { ...selected, slice: undefined },
      candidate.id,
      await currentSubject(),
    ),
  ).toMatchObject({ ok: false, error: { code: "NO_ACTIVE_TASK" } });
  // A local record cannot widen the independently loaded slice authorization.
  const modified = {
    ...candidate,
    files: candidate.files.map((file) =>
      file.path === "package.json"
        ? { ...file, content: Buffer.from("changed").toString("base64") }
        : file,
    ),
  };
  const packageFile = modified.files.find((file) => file.path === "package.json");
  if (!packageFile) throw new Error("package file");
  const { hashValue, sha256 } = await import("../../../../src/core/hash.js");
  packageFile.hash = hashValue({ hash: sha256(Buffer.from("changed")), mode: packageFile.mode });
  await writeFile(candidatePath(state, candidate.feature, candidate.id), JSON.stringify(modified));
  expect(
    await restoreCandidate(state, selected, candidate.id, await currentSubject()),
  ).toMatchObject({ ok: false, error: { code: "SCOPE_VIOLATION" } });
  expect(await readFile(join(state.paths.root, "package.json"), "utf8")).not.toBe("changed");
});
it("rejects a concurrent edit made while planning a restore", async () => {
  const candidate = await preserve();
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const expected = await currentSubject();
  const original = state.files.readBytesIfExists.bind(state.files);
  vi.spyOn(state.files, "readBytesIfExists").mockImplementation(async (path) => {
    if (path === "src/value.mjs") await setup.workspace.write(path, "concurrent user change");
    return original(path);
  });
  expect(await restoreCandidate(state, selected, candidate.id, expected)).toMatchObject({
    ok: false,
    error: { code: "EVIDENCE_FAILED" },
  });
  expect(await readFile(join(state.paths.root, "src/value.mjs"), "utf8")).toBe(
    "concurrent user change",
  );
});
it("recovers an interrupted restoration without changing saved candidate bytes", async () => {
  const candidate = await preserve();
  const path = candidatePath(state, candidate.feature, candidate.id);
  const bytes = await readFile(path);
  await setup.workspace.write("src/value.mjs", "export const value = 8;\n");
  const apply = transactions.applyFileTransaction;
  vi.spyOn(transactions, "applyFileTransaction").mockImplementation((root, label, mutations) =>
    apply(root, label, mutations, {
      afterMutation() {
        throw new Error("interruption");
      },
      leavePreparedOnError: true,
    }),
  );
  expect(
    await restoreCandidate(state, selected, candidate.id, await currentSubject()),
  ).toMatchObject({ ok: false });
  vi.restoreAllMocks();
  expect((await transactions.recoverFileTransactions(state.paths.root)).ok).toBe(true);
  expect(await readFile(join(state.paths.root, "src/value.mjs"), "utf8")).toContain("value = 8");
  expect(await readFile(path)).toEqual(bytes);
});
