import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as transactions from "../../../src/core/file-transaction.js";
import {
  applyFileTransaction,
  type FileMutation,
  type FileTransactionOutcome,
  recoverFileTransactions,
} from "../../../src/core/file-transaction.js";
import type { Result } from "../../../src/core/result.js";
import { installHarness } from "../../../src/harness/install.js";
import { runProductDone } from "../../../src/workflow/product/evidence.js";
import {
  authorizationPath,
  briefPath,
  productStatePath,
} from "../../../src/workflow/product/store.js";
import { runProductWork } from "../../../src/workflow/product/work.js";
import { runInit } from "../../../src/workflow/stages/init.js";
import { productWorkspace } from "../support/product-workspace.js";
import { TestWorkspace } from "../support/workspace.js";

type TransactionRunner = (
  root: string,
  label: string,
  mutations: readonly FileMutation[],
) => Promise<Result<FileTransactionOutcome>>;

interface FaultObservation {
  label?: string;
  mutations?: readonly FileMutation[];
  before?: FileTreeSnapshot;
}

type FileTreeSnapshot = Record<
  string,
  | { readonly kind: "file"; readonly bytes: string; readonly mode?: number }
  | { readonly kind: "symlink"; readonly target: string; readonly mode?: number }
>;

describe("workflow transaction fault injection", () => {
  it("restores exact files and modes after every init mutation", async () => {
    let mutationCount = 1;
    let expectedPlan: readonly string[] | undefined;

    for (let failAt = 1; failAt <= mutationCount; failAt += 1) {
      const root = await initFixture();
      try {
        const observed: FaultObservation = {};
        const result = await runInit(
          { root, harness: "codex", force: true },
          { applyTransaction: faultRunner(failAt, observed) },
        );

        expect(result.ok).toBe(false);
        const paths = requireObservation(root, observed, "project-init");
        mutationCount = paths.length;
        expectedPlan ??= paths;
        expect(paths).toEqual(expectedPlan);
        expect(paths).toEqual([
          ".visp/project.json",
          ".visp/status.json",
          ".gitignore",
          "visp.yml",
        ]);
        await expectRollback(root, observed);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    expect(mutationCount).toBe(4);
  });

  it("restores every install surface after each planned mutation", async () => {
    let mutationCount = 1;
    let expectedPlan: readonly string[] | undefined;
    let kinds: ReadonlyMap<string, FileMutation["kind"]> | undefined;

    for (let failAt = 1; failAt <= mutationCount; failAt += 1) {
      const workspace = await installFixture();
      try {
        const state = await workspace.state();
        const observed: FaultObservation = {};
        const result = await installHarness(
          state.paths,
          {
            harness: "claude-code",
            profile: "minimal",
            hooks: ["claude", "git", "ci"],
            mcp: true,
            force: true,
            prunePreviousHarness: true,
            configUpdates: { harness: "claude-code", profile: "minimal" },
          },
          {
            applyTransaction: faultRunner(failAt, observed),
            guardHandshake: async () => {
              throw new Error("a failed transaction must not reach post-install verification");
            },
          },
        );

        expect(result.ok).toBe(false);
        const paths = requireObservation(workspace.root, observed, "harness-install");
        mutationCount = paths.length;
        expectedPlan ??= paths;
        expect(paths).toEqual(expectedPlan);
        kinds ??= mutationKinds(workspace.root, observed.mutations ?? []);
        expect(mutationKinds(workspace.root, observed.mutations ?? [])).toEqual(kinds);
        await expectRollback(workspace.root, observed);
      } finally {
        await workspace.destroy();
      }
    }

    expect(mutationCount).toBeGreaterThan(12);
    expect(expectedPlan?.slice(-2)).toEqual([".visp/state/asset-manifest.json", "visp.yml"]);
    expect(kinds?.get(".claude/skills/visp/SKILL.md")).toBe("remove");
    expect(kinds?.get(".agents/skills/visp/SKILL.md")).toBe("remove");
    expect(kinds?.get("AGENTS.md")).toBe("write");
    expect(kinds?.get(".visp/hooks/claude-pretooluse.mjs")).toBe("write");
    expect(kinds?.get(".claude/settings.json")).toBe("write");
    expect(kinds?.get(".git/hooks/pre-commit")).toBe("write");
    expect(kinds?.get(".github/workflows/visp.yml")).toBe("write");
    expect(kinds?.get(".mcp.json")).toBe("write");
    expect(kinds?.get(".visp/state/install.json")).toBe("write");
    expect(kinds?.get(".visp/state/asset-manifest.json")).toBe("write");
    expect(kinds?.get("visp.yml")).toBe("write");
  }, 120_000);

  it("restores brief, product state, authorization and status after every slice closure mutation", async () => {
    let mutationCount = 1;
    for (let failAt = 1; failAt <= mutationCount; failAt++) {
      const { workspace, brief } = await productWorkspace();
      const original = applyFileTransaction;
      try {
        const worked = await runProductWork(await workspace.state());
        if (!worked.ok) throw new Error(worked.error.message);
        await workspace.write("src/value.mjs", "export const value = 2;\n");
        const state = await workspace.state();
        await setMode(authorizationPath(state, brief.feature), 0o600);
        await setMode(productStatePath(state, brief.feature), 0o640);
        await setMode(state.paths.status, 0o600);
        const observed: FaultObservation = {};
        vi.spyOn(transactions, "applyFileTransaction").mockImplementation(
          faultRunner(failAt, observed, original),
        );
        const result = await runProductDone(state, { feature: brief.feature, task: "T001" });
        vi.restoreAllMocks();
        expect(result.ok).toBe(false);
        const paths = requireObservation(workspace.root, observed, "product-state");
        mutationCount = paths.length;
        expect(paths).toEqual(
          [
            briefPath(state, brief.feature),
            productStatePath(state, brief.feature),
            authorizationPath(state, brief.feature),
            ".visp/status.json",
          ].map((path) => relativeMutationPath(workspace.root, path)),
        );
        await expectRollback(workspace.root, observed);
      } finally {
        vi.restoreAllMocks();
        await workspace.destroy();
      }
    }
    expect(mutationCount).toBe(4);
  });
});

function faultRunner(
  failAt: number,
  observed: FaultObservation,
  apply = applyFileTransaction,
): TransactionRunner {
  return async (root, label, mutations) => {
    observed.label = label;
    observed.mutations = mutations;
    observed.before = await snapshotFiles(root);
    return apply(root, label, mutations, {
      afterMutation(applied) {
        if (applied === failAt) throw new Error(`injected failure after mutation ${applied}`);
      },
      leavePreparedOnError: true,
    });
  };
}

function requireObservation(
  root: string,
  observed: FaultObservation,
  expectedLabel: string,
): string[] {
  expect(observed.label).toBe(expectedLabel);
  expect(observed.before).toBeDefined();
  expect(observed.mutations).toBeDefined();
  return (observed.mutations ?? []).map((mutation) => relativeMutationPath(root, mutation.path));
}

function mutationKinds(
  root: string,
  mutations: readonly FileMutation[],
): ReadonlyMap<string, FileMutation["kind"]> {
  return new Map(
    mutations.map((mutation) => [relativeMutationPath(root, mutation.path), mutation.kind]),
  );
}

async function expectRollback(root: string, observed: FaultObservation): Promise<void> {
  expect(observed.before).toBeDefined();
  const recovered = await recoverFileTransactions(root);
  expect(recovered.ok).toBe(true);
  if (!recovered.ok) throw new Error(recovered.error.message);
  expect(recovered.value).toHaveLength(1);
  const durableBefore = { ...observed.before };
  // An outer mutation owns this temporary coordination file; recovery must release it.
  delete durableBefore[".visp/state/mutation.lock/owner.json"];
  expect(await snapshotFiles(root)).toEqual(durableBefore);
}

async function initFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "visp-init-fault-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFixture(root, "package.json", '{"name":"fault-fixture"}\n', 0o644);
  await writeFixture(root, ".gitignore", "project-cache/\n", 0o600);
  await writeFixture(root, "visp.yml", "# existing project configuration\n", 0o640);
  return root;
}

async function installFixture(): Promise<TestWorkspace> {
  const workspace = await TestWorkspace.create();
  let state = await workspace.state();
  const codex = await installHarness(state.paths, {
    harness: "codex",
    profile: "standard",
    hooks: [],
    mcp: false,
  });
  if (!codex.ok) throw new Error(codex.error.message);

  state = await workspace.state();
  const claude = await installHarness(state.paths, {
    harness: "claude-code",
    profile: "standard",
    hooks: [],
    mcp: false,
  });
  if (!claude.ok) throw new Error(claude.error.message);

  const agents = join(workspace.root, "AGENTS.md");
  await writeFile(agents, `# Project instructions\n\n${await readFile(agents, "utf8")}`, "utf8");
  await writeFixture(
    workspace.root,
    ".claude/settings.json",
    '{"permissions":{"allow":["Read"]}}\n',
    0o600,
  );
  await writeFixture(
    workspace.root,
    ".mcp.json",
    '{"mcpServers":{"project":{"command":"project-server"}}}\n',
    0o640,
  );
  await writeFixture(
    workspace.root,
    ".git/hooks/pre-commit",
    "#!/bin/sh\necho project hook\n",
    0o600,
  );
  await writeFixture(
    workspace.root,
    ".github/workflows/visp.yml",
    "name: project workflow\n",
    0o640,
  );
  await setMode(join(workspace.root, "visp.yml"), 0o600);
  await setMode(join(workspace.root, ".visp/state/asset-manifest.json"), 0o640);
  await setMode(agents, 0o600);
  return workspace;
}

async function writeFixture(
  root: string,
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, { encoding: "utf8", mode });
  await setMode(absolute, mode);
}

async function setMode(path: string, mode: number): Promise<void> {
  if (process.platform !== "win32") await chmod(path, mode);
}

function relativeMutationPath(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  return relative(root, absolute).replaceAll("\\", "/");
}

async function snapshotFiles(root: string): Promise<FileTreeSnapshot> {
  const snapshot: FileTreeSnapshot = {};
  await visit("");
  return snapshot;

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      const absolute = join(root, path);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      const metadata = await lstat(absolute);
      const mode = process.platform === "win32" ? {} : { mode: metadata.mode & 0o777 };
      snapshot[path] = entry.isSymbolicLink()
        ? { kind: "symlink", target: await readlink(absolute), ...mode }
        : { kind: "file", bytes: (await readFile(absolute)).toString("base64"), ...mode };
    }
  }
}
