import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vispError } from "../../../../src/core/errors.js";
import { ProjectFileSystem } from "../../../../src/core/fs.js";
import { hashValue } from "../../../../src/core/hash.js";
import { ProjectPaths } from "../../../../src/core/paths.js";
import { err } from "../../../../src/core/result.js";
import type { Review, Verification } from "../../../../src/workflow/artifacts/evidence.js";
import { ArtifactStore } from "../../../../src/workflow/artifacts/store.js";

let root: string;
let paths: ProjectPaths;
let store: ArtifactStore;
const feature = "001-atomic";
const record: Verification = {
  kind: "verification",
  createdAt: "2026-09-05T00:00:00.000Z",
  feature,
  task: "T001",
  passed: true,
  codeEvidence: "executed",
  commands: [],
  changedFiles: [],
  findings: [],
  attempt: 1,
};
const review: Review = {
  kind: "review",
  createdAt: record.createdAt,
  feature,
  task: "T001",
  passed: true,
  basis: "working-tree",
  reviewedFiles: [],
  criteria: [],
  findings: [],
  attempt: 1,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-evidence-atomic-"));
  paths = new ProjectPaths(root);
  store = new ArtifactStore(paths);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("atomic evidence attempt persistence", () => {
  it.each(["verification", "review"] as const)(
    "rolls back %s history when the applicable projection cannot be written",
    async (kind) => {
      const original = ProjectFileSystem.prototype.writeBytesAtomic;
      const target = paths.evidenceFile(feature, "T001", `${kind}.json`);
      vi.spyOn(ProjectFileSystem.prototype, "writeBytesAtomic").mockImplementation(function (
        this: ProjectFileSystem,
        path,
        content,
        mode,
      ) {
        if (resolve(root, path) === target)
          return Promise.resolve(err(vispError("IO_ERROR", "fixture projection failure")));
        return original.call(this, path, content, mode);
      });
      const result =
        kind === "verification"
          ? await store.writeVerificationAttempt(record)
          : await store.writeReviewAttempt(review);
      expect(result.ok).toBe(false);
      const history =
        kind === "verification"
          ? await store.readVerificationAttempts(feature, "T001")
          : await store.readReviewAttempts(feature, "T001");
      expect(history.ok && history.value).toEqual([]);
    },
  );

  it("retains stale concurrent attempts without replacing a newer applicable verification", async () => {
    expect(
      (await store.writeVerificationAttempt({ ...record, attempt: 2, changedFiles: ["new.ts"] }))
        .ok,
    ).toBe(true);
    const stale = await store.writeVerificationAttempt({ ...record, changedFiles: ["old.ts"] });
    expect(stale.ok).toBe(false);
    expect(stale.ok ? undefined : stale.error.details).toMatchObject({
      historySaved: true,
      projectionUpdated: false,
    });
    const current = await store.readVerification(feature, "T001");
    expect(current.ok && current.value?.changedFiles).toEqual(["new.ts"]);
    const history = await store.readVerificationAttempts(feature, "T001");
    expect(history.ok && history.value).toHaveLength(2);
  });

  it("serializes simultaneous history/projection mutations across store instances", async () => {
    const other = new ArtifactStore(paths);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 ? store : other).writeVerificationAttempt({
          ...record,
          task: `T${String(index + 1).padStart(3, "0")}`,
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await store.readAllVerifications(feature)).ok).toBe(true);
  });

  it("checks the current projection revision captured before execution", async () => {
    await store.writeReviewAttempt(review);
    const before = await store.readReview(feature, "T001");
    if (!before.ok || !before.value) throw new Error("fixture");
    await store.writeReviewAttempt({ ...review, attempt: 2, reviewedFiles: ["new.ts"] });
    const result = await store.writeReviewAttempt(
      { ...review, attempt: 3, reviewedFiles: ["stale.ts"] },
      { expectedCurrentHash: hashValue(before.value) },
    );
    expect(result.ok).toBe(false);
    const current = await store.readReview(feature, "T001");
    expect(current.ok && current.value?.reviewedFiles).toEqual(["new.ts"]);
  });
});
