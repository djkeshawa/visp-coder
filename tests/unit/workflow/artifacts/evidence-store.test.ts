import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyFileTransaction,
  inspectFileTransactions,
} from "../../../../src/core/file-transaction.js";
import { ProjectPaths } from "../../../../src/core/paths.js";
import type { Review, Verification } from "../../../../src/workflow/artifacts/evidence.js";
import { ArtifactStore } from "../../../../src/workflow/artifacts/store.js";

/**
 * Two tasks worked in parallel used to write the same `verification.json`, so
 * merging their branches conflicted on every close and only the last task's
 * record survived. Evidence is now filed under the task that earned it.
 */

const feature = "001-parallel";
const createdAt = "2026-01-01T00:00:00.000Z";

function verification(task: string | undefined, changedFiles: string[]): Verification {
  return {
    kind: "verification",
    createdAt,
    feature,
    ...(task ? { task } : {}),
    passed: true,
    codeEvidence: "executed",
    commands: [],
    changedFiles,
    findings: [],
  };
}

function review(task: string, reviewedFiles: string[], passed = true): Review {
  return {
    kind: "review",
    createdAt,
    feature,
    task,
    passed,
    basis: "working-tree",
    criteria: [],
    reviewedFiles,
    findings: [],
  };
}

describe("evidence store", () => {
  let root: string;
  let outside: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "visp-evidence-"));
    outside = await mkdtemp(join(tmpdir(), "visp-evidence-outside-"));
    store = new ArtifactStore(new ProjectPaths(root));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("keeps each task's record instead of overwriting the last one", async () => {
    await store.writeVerification(verification("T001", ["src/a.ts"]));
    await store.writeVerification(verification("T002", ["src/b.ts"]));

    const first = await store.readVerification(feature, "T001");
    const second = await store.readVerification(feature, "T002");

    expect(first.ok && first.value?.changedFiles).toEqual(["src/a.ts"]);
    expect(second.ok && second.value?.changedFiles).toEqual(["src/b.ts"]);
  });

  it("cannot redirect artifact writes through a symlinked state directory", async () => {
    await symlink(outside, join(root, ".visp"), "dir");

    const result = await store.writeVerification(verification("T001", ["src/a.ts"]));

    expect(result.ok).toBe(false);
    expect(await readdir(outside)).toEqual([]);
  });

  it("recovers an abandoned transaction before a default store mutation", async () => {
    await writeFile(join(root, "sentinel.txt"), "before\n", "utf8");
    const interrupted = await applyFileTransaction(
      root,
      "interrupted-before-store-write",
      [{ kind: "write", path: "sentinel.txt", content: "partial\n" }],
      {
        afterMutation() {
          throw new Error("process stopped");
        },
        leavePreparedOnError: true,
      },
    );
    expect(interrupted.ok).toBe(false);

    const written = await store.writeVerification(verification("T001", ["src/a.ts"]));

    expect(written.ok).toBe(true);
    await expect(readFile(join(root, "sentinel.txt"), "utf8")).resolves.toBe("before\n");
    const inspected = await inspectFileTransactions(root);
    expect(inspected.ok && inspected.value.pending).toEqual([]);
  });

  it.each([undefined, "behavioral", "structural", "unclassified"] as const)(
    "reads legacy and current flip labels without changing the executed result: %s",
    async (signal) => {
      const wrote = await store.writeVerification({
        ...verification("T001", ["src/a.ts"]),
        flip: {
          failsWithoutChange: true,
          ...(signal ? { signal } : {}),
          revertedFiles: ["src/a.ts"],
          preservedValidationFiles: [],
          commands: [],
        },
      });
      expect(wrote.ok).toBe(true);

      const read = await store.readVerification(feature, "T001");
      expect(read.ok && read.value?.flip?.failsWithoutChange).toBe(true);
      expect(read.ok && read.value?.flip?.signal).toBe(signal);
    },
  );

  it("falls back to the feature-wide record when a task has none", async () => {
    await store.writeVerification(verification(undefined, ["src/whole.ts"]));

    const scoped = await store.readVerification(feature, "T009");

    expect(scoped.ok && scoped.value?.changedFiles).toEqual(["src/whole.ts"]);
  });

  it("ignores root-level evidence attachments when collecting task records", async () => {
    await store.writeReview(review("T001", ["src/a.ts"]));
    const paths = new ProjectPaths(root);
    await writeFile(join(paths.evidenceDir(feature), "active-mobile.png"), "image", "utf8");

    const reviews = await store.readAllReviews(feature);
    const observations = await store.readAllObservations(feature);

    expect(reviews.ok && reviews.value.map((record) => record.task)).toEqual(["T001"]);
    expect(observations.ok && observations.value).toEqual([]);
  });

  it("stores advisory observations beside their owning task", async () => {
    const observations = await store.writeObservations({
      kind: "observations",
      createdAt,
      feature,
      task: "T001",
      observations: [],
    });

    expect(observations.ok).toBe(true);
    expect((await store.readObservations(feature, "T001")).ok).toBe(true);
  });
});
