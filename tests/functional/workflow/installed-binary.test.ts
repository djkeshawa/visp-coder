import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = resolve(process.cwd(), "dist/cli.js");

async function initializedProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visp-opencode-install-"));
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n', "utf8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("node", [CLI, "--project", root, "init", "--harness", "opencode"], {
    cwd: root,
  });
  await mkdir(join(root, ".bin"));
  await symlink(CLI, join(root, ".bin/visp"));
  return root;
}

function projectEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${join(root, ".bin")}:${process.env.PATH ?? ""}` };
}

/**
 * How visp behaves when it is *installed* rather than run from a checkout.
 *
 * Both bugs below shipped because the harness modelled an install as a wrapper
 * script — `exec node /abs/path/cli.js "$@"` — which invokes the CLI by its real
 * path. A package manager does not do that. It writes a symlink, and every
 * question that compares argv[1] to the module's own URL then answers
 * differently. The distinction is invisible from inside a checkout, so it has to
 * be tested from outside one.
 */
describe("installed as a package binary", () => {
  async function symlinkedBin(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "visp-bin-"));
    const link = join(dir, "visp");
    await symlink(CLI, link);
    return link;
  }

  /**
   * The regression: argv[1] was the symlink and `import.meta.url` its target, so
   * the entrypoint check said "not the program being run", nothing was parsed,
   * and the process exited 0 having printed nothing. Silent success is the worst
   * available failure — every caller reads it as consent.
   */
  it("runs when invoked through a symlink, as a package manager installs it", async () => {
    const link = await symlinkedBin();

    const stdout = execFileSync("node", [link, "--version"], { encoding: "utf8" });

    expect(stdout.trim()).not.toBe("");
  });

  it("answers guard through the symlink with a parseable envelope", async () => {
    const link = await symlinkedBin();
    const root = await mkdtemp(join(tmpdir(), "visp-installed-"));

    await writeFile(join(root, "package.json"), '{"name":"fixture"}\n', "utf8");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });

    let stdout = "";
    try {
      stdout = execFileSync(
        "node",
        [link, "--project", root, "guard", "--path", "src/a.ts", "--json"],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
    } catch (error) {
      stdout = String((error as { stdout?: unknown }).stdout ?? "");
    }

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(JSON.parse(stdout).command).toBe("guard");
  });
});

describe("installed for OpenCode", () => {
  it("writes and names the project-local OpenCode MCP registration", async () => {
    const root = await initializedProject();

    const stdout = execFileSync(
      "node",
      [
        CLI,
        "--project",
        root,
        "install",
        "--harness",
        "opencode",
        "--profile",
        "minimal",
        "--no-hooks",
      ],
      { cwd: root, encoding: "utf8", env: projectEnv(root) },
    );

    expect(stdout).toContain("opencode.json");
    const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"));
    expect(config.mcp.visp.command).toEqual(["visp", "serve", "--mcp"]);
  });

  it("does not claim an MCP profile change when registration is disabled", async () => {
    const root = await initializedProject();

    const stdout = execFileSync(
      "node",
      [
        CLI,
        "--project",
        root,
        "install",
        "--harness",
        "opencode",
        "--profile",
        "minimal",
        "--no-hooks",
        "--no-mcp",
      ],
      { cwd: root, encoding: "utf8", env: projectEnv(root) },
    );

    expect(stdout).not.toContain("MCP tool set follows the profile");
  });

  it("refuses an unsafe MCP configuration without claiming activation", async () => {
    const root = await initializedProject();
    const original = '{\n  "model": "keep-me",\n  "mcp": []\n}\n';
    await writeFile(join(root, "opencode.json"), original, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "--project",
        root,
        "install",
        "--harness",
        "opencode",
        "--profile",
        "minimal",
        "--no-hooks",
      ],
      { cwd: root, encoding: "utf8", env: projectEnv(root) },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("opencode.json");
    expect(result.stdout).not.toContain("registered as an MCP server");
    expect(result.stdout).not.toContain("MCP tool set follows the profile");
    expect(await readFile(join(root, "opencode.json"), "utf8")).toBe(original);
  });

  it("preserves and refuses a customized MCP entry without --force", async () => {
    const root = await initializedProject();
    const original = `{
  "model": "keep-me",
  "mcp": {
    "visp": {
      "type": "local",
      "command": ["/custom/visp", "serve", "--mcp"]
    }
  }
}
`;
    await writeFile(join(root, "opencode.json"), original, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "--project",
        root,
        "install",
        "--harness",
        "opencode",
        "--profile",
        "minimal",
        "--no-hooks",
      ],
      { cwd: root, encoding: "utf8", env: projectEnv(root) },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("left unchanged");
    expect(result.stderr).toContain("--force");
    expect(result.stdout).not.toContain("MCP tool set follows the profile");
    expect(result.stdout).not.toContain("restart your MCP client");
    expect(result.stdout).not.toContain("registered as an MCP server");
    expect(await readFile(join(root, "opencode.json"), "utf8")).toBe(original);
  });
});

/**
 * What the PreToolUse hook does when `visp` on PATH is not this visp.
 *
 * Three `visp*` packages can be installed at once, and a hook that shells out by
 * bare name reaches whichever one PATH finds. The hook used to key its decision
 * on the exit status alone, and an argument parser answers 1 for an unknown
 * option — so a foreign binary produced a confident, specific scope violation
 * for every write, sending someone to widen `allowedFiles` to fix an install.
 */
describe("the hook when PATH holds a different visp", () => {
  async function hookOutput(fake: string): Promise<{ decision: string; reason: string }> {
    const root = await mkdtemp(join(tmpdir(), "visp-foreign-"));
    const bin = await mkdtemp(join(tmpdir(), "visp-fakebin-"));
    const installBin = await mkdtemp(join(tmpdir(), "visp-current-bin-"));
    await symlink(CLI, join(installBin, "visp"));

    await writeFile(join(root, "package.json"), '{"name":"fixture"}\n', "utf8");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });

    execFileSync("node", [CLI, "--project", root, "init", "--harness", "claude-code"], {
      cwd: root,
    });
    execFileSync(
      "node",
      [
        CLI,
        "--project",
        root,
        "install",
        "--harness",
        "claude-code",
        "--hooks",
        "claude",
        "--no-mcp",
      ],
      {
        cwd: root,
        env: { ...process.env, PATH: `${installBin}:${process.env.PATH ?? ""}` },
      },
    );

    const shim = join(bin, "visp");
    await writeFile(shim, fake, "utf8");
    await chmod(shim, 0o755);

    const stdout = execFileSync("node", [join(root, ".visp/hooks/claude-pretooluse.mjs")], {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/a.ts" } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    const parsed = JSON.parse(stdout).hookSpecificOutput;
    return { decision: parsed.permissionDecision, reason: parsed.permissionDecisionReason };
  }

  /** Exit 1 from an argument parser is not a scope refusal, and must not read as one. */
  it("names the install, not the scope, when the foreign binary rejects the arguments", async () => {
    const { decision, reason } = await hookOutput(
      "#!/bin/sh\necho \"error: unknown option '--path'\" >&2\nexit 1\n",
    );

    expect(decision).toBe("deny");
    expect(reason).toContain("could not check");
    expect(reason).not.toContain("outside the scope");
  });

  /** The dangerous direction: a success status from something that checked nothing. */
  it("refuses rather than allowing when the foreign binary exits zero", async () => {
    const { decision, reason } = await hookOutput("#!/bin/sh\necho '{\"ok\":true}'\nexit 0\n");

    expect(decision).toBe("deny");
    expect(reason).toContain("could not check");
  });
});
