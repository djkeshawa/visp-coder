import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestProject } from "../../functional/support/project.js";

const CLI = resolve(process.cwd(), "dist/cli.js");
const roots: string[] = [];

interface ErrorEnvelope {
  readonly ok: boolean;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly recovery?: string;
    readonly details?: Record<string, unknown>;
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bootstrap prerequisites", () => {
  it("refuses init before writing anything when Git is unavailable", async () => {
    const root = await temporaryRoot();
    const { exitCode, envelope } = runJson(root, "init", "--harness", "codex");

    expect(exitCode).not.toBe(0);
    expect(envelope.error).toMatchObject({
      code: "STAGE_BLOCKED",
      recovery: "git init",
      details: {
        blocker: "repository",
        gitMetadataPresent: false,
        mayEdit: false,
        restartAgentAfterSetup: true,
        suppressFailure: false,
      },
    });
    expect(envelope.error?.message).toMatch(/stop before editing/i);
    expect(envelope.error?.message).toMatch(/do not suppress/i);
    expect(await pathExists(join(root, ".visp"))).toBe(false);
    expect(await pathExists(join(root, "visp.yml"))).toBe(false);
  });

  it("identifies unusable Git metadata instead of treating it as a new repository", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, ".git"));

    const { envelope } = runJson(root, "init", "--harness", "codex");

    expect(envelope.error?.details?.gitMetadataPresent).toBe(true);
    expect(envelope.error?.recovery).toMatch(/repair/i);
    expect(await pathExists(join(root, ".visp"))).toBe(false);
  });

  it("does not partially install assets when the Git boundary disappears", async () => {
    const project = await TestProject.create();
    roots.push(project.root);
    expect(project.run("init", "--harness", "generic").exitCode).toBe(0);
    await rm(join(project.root, ".git"), { recursive: true, force: true });

    const { result, envelope } = project.json<never>("install", "--harness", "codex");

    expect(result.exitCode).not.toBe(0);
    expect(envelope.error).toMatchObject({
      code: "STAGE_BLOCKED",
      details: { blocker: "repository", mayEdit: false },
    });
    expect(await pathExists(join(project.root, "AGENTS.visp.md"))).toBe(false);
    expect(await pathExists(join(project.root, ".agents"))).toBe(false);
    expect(await pathExists(join(project.root, ".codex"))).toBe(false);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visp-bootstrap-"));
  roots.push(root);
  return root;
}

function runJson(root: string, ...args: string[]): { exitCode: number; envelope: ErrorEnvelope } {
  const result = spawnSync(process.execPath, [CLI, "--project", root, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    exitCode: result.status ?? 1,
    envelope: JSON.parse(result.stdout) as ErrorEnvelope,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
