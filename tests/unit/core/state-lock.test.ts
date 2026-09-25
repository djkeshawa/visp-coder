import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCT_CHECK_CONTEXT,
  productCheckEnvironment,
  withProductCheckContext,
} from "../../../src/core/check-context.js";
import { ProjectFileSystem } from "../../../src/core/fs.js";
import { ok } from "../../../src/core/result.js";
import {
  inspectStateLock,
  STATE_LOCK_DIRECTORY,
  withStateLock,
} from "../../../src/core/state-lock.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "visp-lock-"));
  roots.push(value);
  return value;
}

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("worktree state ownership", () => {
  it.each(["missing", "changed", "symlink"])(
    "refuses a %s command-check receipt instead of crediting an exit-zero wrapper",
    async (kind) => {
      const project = await root();
      const unrelated = join(project, "unrelated");
      await writeFile(unrelated, "preserve this file");
      const result = await withProductCheckContext(project, "C001", async (environment) => {
        const contexts = JSON.parse(environment[PRODUCT_CHECK_CONTEXT] ?? "[]");
        const directory = contexts.at(-1).receipt.directory;
        const receipt = join(directory, "receipt");
        if (kind === "changed") await writeFile(receipt, "forged pass");
        else {
          await unlink(receipt);
          if (kind === "symlink") await symlink(unrelated, receipt);
        }
        vi.stubEnv(PRODUCT_CHECK_CONTEXT, environment[PRODUCT_CHECK_CONTEXT]);
        expect(await withStateLock(project, async () => ok("must not mutate"))).toMatchObject({
          ok: false,
          error: { code: "ARTIFACT_INVALID" },
        });
        return ok("wrapper hides the child's failure");
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "COMMAND_FAILED",
          message: expect.stringContaining("receipt unavailable or changed"),
        },
      });
      expect(await readFile(unrelated, "utf8")).toBe("preserve this file");
    },
  );

  it("never writes an arbitrary inherited receipt path", async () => {
    const project = await root();
    await writeFile(join(project, "receipt"), "keep unrelated data");
    vi.stubEnv(
      PRODUCT_CHECK_CONTEXT,
      JSON.stringify([
        {
          root: project,
          check: "C001",
          receipt: { directory: project, token: "attacker-controlled" },
        },
      ]),
    );
    expect(await withStateLock(project, async () => ok("must not mutate"))).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID" },
    });
    expect(await readFile(join(project, "receipt"), "utf8")).toBe("keep unrelated data");
  });
  it("rejects inherited command-check mutations before lock acquisition or reentrancy", async () => {
    const project = await root();
    const operation = vi.fn(async () => ok("must not mutate"));
    const result = await withStateLock(project, async () => {
      vi.stubEnv(PRODUCT_CHECK_CONTEXT, JSON.stringify([{ root: project, check: "C001" }]));
      return withStateLock(project, operation, { timeoutMs: 0 });
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ARTIFACT_INVALID",
        details: { reason: "recursive-workflow-mutation", check: "C001" },
      },
    });
    expect(operation).not.toHaveBeenCalled();
    expect(await inspectStateLock(project)).toEqual(ok({ state: "unlocked" }));
  });

  it("rejects command-check recursion before entering lock acquisition filesystem work", async () => {
    const project = await root();
    vi.stubEnv(PRODUCT_CHECK_CONTEXT, JSON.stringify([{ root: project, check: "C001" }]));
    const acquisition = vi.spyOn(ProjectFileSystem.prototype, "ensureDir");
    const operation = vi.fn(async () => ok("must not mutate"));
    try {
      expect(await withStateLock(project, operation, { timeoutMs: 0 })).toMatchObject({
        ok: false,
        error: {
          code: "ARTIFACT_INVALID",
          details: { reason: "recursive-workflow-mutation", check: "C001" },
        },
      });
      expect(acquisition).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(await inspectStateLock(project)).toEqual(ok({ state: "unlocked" }));
    } finally {
      acquisition.mockRestore();
    }
  });

  it("supports helpers that test an independent workspace while preserving ancestor guards", async () => {
    const outer = await root(),
      inner = await root();
    const environment = await productCheckEnvironment(outer, "C001");
    vi.stubEnv(PRODUCT_CHECK_CONTEXT, environment[PRODUCT_CHECK_CONTEXT]);
    expect(await withStateLock(inner, async () => ok("independent test fixture"))).toEqual(
      ok("independent test fixture"),
    );
    const nested = await productCheckEnvironment(inner, "C002");
    vi.stubEnv(PRODUCT_CHECK_CONTEXT, nested[PRODUCT_CHECK_CONTEXT]);
    for (const project of [outer, inner])
      expect(await withStateLock(project, async () => ok("blocked"))).toMatchObject({
        ok: false,
        error: { details: { reason: "recursive-workflow-mutation" } },
      });
  });

  it("keeps coordination parents stable while another writer is preparing to acquire", async () => {
    const project = await root();
    const entered = signal();
    const releaseOwner = signal();
    const preparing = signal();
    const resumeContender = signal();
    const ensureDir = ProjectFileSystem.prototype.ensureDir;
    let pauseNext = false;
    const prepare = vi
      .spyOn(ProjectFileSystem.prototype, "ensureDir")
      .mockImplementation(async function (this: ProjectFileSystem, path) {
        const ready = await ensureDir.call(this, path);
        if (pauseNext && path === ".visp/state") {
          pauseNext = false;
          preparing.resolve();
          await resumeContender.promise;
        }
        return ready;
      });
    const owner = withStateLock(project, async () => {
      entered.resolve();
      await releaseOwner.promise;
      return ok("first");
    });
    await entered.promise;
    pauseNext = true;
    const contender = withStateLock(project, async () => ok("second"));
    let stableParent = false;
    try {
      await preparing.promise;
      releaseOwner.resolve();
      expect(await owner).toEqual(ok("first"));
      const parent = await new ProjectFileSystem(project).metadata(".visp/state");
      stableParent = parent.ok && parent.value?.type === "directory";
    } finally {
      releaseOwner.resolve();
      resumeContender.resolve();
      await Promise.allSettled([owner, contender]);
      prepare.mockRestore();
    }
    expect(stableParent).toBe(true);
    expect(await contender).toEqual(ok("second"));
    expect(await inspectStateLock(project)).toEqual(ok({ state: "unlocked" }));
  });

  it("detects a live owner and times out without stealing its lock", async () => {
    const project = await root();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = withStateLock(project, async () => {
      entered();
      await hold;
      return ok(undefined);
    });
    await ready;
    expect(await inspectStateLock(project)).toMatchObject({ ok: true, value: { state: "active" } });
    const blocked = await withStateLock(project, async () => ok("cannot enter"), { timeoutMs: 0 });
    expect(!blocked.ok && blocked.error.code).toBe("STATE_BUSY");
    expect(!blocked.ok && blocked.error.recovery).toContain("original host command/session handle");
    expect(!blocked.ok && blocked.error.recovery).toContain("do not delete a lock");
    release();
    expect((await active).ok).toBe(true);
  });

  it("reclaims an abandoned same-host process, including competing reclaimers", async () => {
    const project = await root();
    const pid = Number(
      execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
        encoding: "utf8",
      }),
    );
    await mkdir(join(project, STATE_LOCK_DIRECTORY), { recursive: true });
    await writeFile(
      join(project, STATE_LOCK_DIRECTORY, "owner.json"),
      JSON.stringify({
        version: 1,
        token: randomUUID(),
        pid,
        host: hostname(),
        createdAt: new Date().toISOString(),
      }),
    );
    expect(await inspectStateLock(project)).toMatchObject({
      ok: true,
      value: { state: "abandoned" },
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => withStateLock(project, async () => ok("recovered"))),
    );
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(await inspectStateLock(project)).toEqual(ok({ state: "unlocked" }));
  });

  it.each(["", "not-json", "{}"])("refuses ambiguous owner data %j", async (content) => {
    const project = await root();
    await mkdir(join(project, STATE_LOCK_DIRECTORY), { recursive: true });
    if (content) await writeFile(join(project, STATE_LOCK_DIRECTORY, "owner.json"), content);
    expect(await inspectStateLock(project)).toEqual(ok({ state: "ambiguous" }));
    const result = await withStateLock(project, async () => ok("cannot enter"), { timeoutMs: 0 });
    expect(!result.ok && result.error.code).toBe("STATE_BUSY");
  });

  it("refuses a missing root and invalid timeouts", async () => {
    const project = await root();
    expect((await withStateLock(join(project, "missing"), async () => ok(true))).ok).toBe(false);
    for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await withStateLock(project, async () => ok(true), { timeoutMs })).ok).toBe(false);
    }
  });

  it("does not unlink a changed ownership token during release", async () => {
    const project = await root();
    const changed = await withStateLock(project, async () => {
      await writeFile(
        join(project, STATE_LOCK_DIRECTORY, "owner.json"),
        JSON.stringify({
          version: 1,
          token: randomUUID(),
          pid: process.pid,
          host: hostname(),
          createdAt: new Date().toISOString(),
        }),
      );
      return ok(undefined);
    });
    expect(!changed.ok && changed.error.code).toBe("STATE_BUSY");
    expect(await inspectStateLock(project)).toMatchObject({ ok: true, value: { state: "active" } });
  });

  it("serializes sibling mutations inside an already owned operation", async () => {
    const project = await root();
    let count = 0;
    const result = await withStateLock(project, async () => {
      const children = await Promise.all(
        Array.from({ length: 6 }, () =>
          withStateLock(project, async () => {
            const before = count;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return withStateLock(project, async () => ok(++count === before + 1));
          }),
        ),
      );
      return ok(children);
    });
    expect(result.ok && result.value.every((child) => child.ok && child.value)).toBe(true);
    expect(count).toBe(6);
  });

  it("serializes independent operations and permits awaited reentrancy", async () => {
    const project = await root();
    let count = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        withStateLock(project, async () => {
          const before = count;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return withStateLock(project, async () => {
            count = before + 1;
            return ok(count);
          });
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(count).toBe(8);
    expect(await inspectStateLock(project)).toEqual(ok({ state: "unlocked" }));
  });

  it("releases ownership when a callback throws", async () => {
    const project = await root();
    expect(
      (
        await withStateLock(project, async () => {
          throw new Error("fault");
        })
      ).ok,
    ).toBe(false);
    expect(await withStateLock(project, async () => ok("next"))).toEqual(ok("next"));
  });

  it("refuses ambiguous ownership without removing it", async () => {
    const project = await root();
    await mkdir(join(project, STATE_LOCK_DIRECTORY), { recursive: true });
    await writeFile(
      join(project, STATE_LOCK_DIRECTORY, "owner.json"),
      JSON.stringify({
        version: 1,
        token: randomUUID(),
        pid: process.pid,
        host: `${hostname()}-different-host`,
        createdAt: new Date().toISOString(),
      }),
    );
    const result = await withStateLock(project, async () => ok("must not run"), { timeoutMs: 15 });
    expect(!result.ok && result.error.code).toBe("STATE_BUSY");
    const inspection = await inspectStateLock(project);
    expect(inspection.ok && inspection.value.state).toBe("ambiguous");
  });
});
