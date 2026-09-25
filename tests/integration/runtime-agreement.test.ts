import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { runtimeIdentity } from "../../src/core/version.js";
import { TestWorkspace } from "../unit/support/workspace.js";

it("a running MCP detects a newly mismatched guard even when package versions match", async () => {
  const workspace = await TestWorkspace.create({ "src/value.js": "export const value=1;" });
  const client = new Client({ name: "runtime-agreement-test", version: "1" });
  try {
    await workspace.installFoundation();
    const current = runtimeIdentity();
    const previousBuild =
      current.buildId === "aaaaaaaaaaaaaaaa" ? "bbbbbbbbbbbbbbbb" : "aaaaaaaaaaaaaaaa";
    const previous = join(workspace.root, ".visp", "runtime-fixture");
    const bin = join(workspace.root, ".visp", "runtime-bin");
    await mkdir(previous, { recursive: true });
    await mkdir(bin, { recursive: true });
    let declarations = 0;
    // Two actual processes with different compiled identities. This is a controlled
    // build-identity fixture, not a claim to reproduce a particular released version.
    for (const name of (await readdir(resolve("dist"))).filter((name) => name.endsWith(".js"))) {
      const source = await readFile(resolve("dist", name), "utf8");
      const changed = source.replace(/var BUILD_ID = [^;\n]+;/g, () => {
        declarations++;
        return `var BUILD_ID = ${JSON.stringify(previousBuild)};`;
      });
      await writeFile(join(previous, name), changed);
    }
    expect(declarations).toBe(1);
    await writeFile(join(previous, "package.json"), '{"type":"module"}');
    await symlink(resolve("node_modules"), join(previous, "node_modules"), "dir");
    async function pointGuardAt(entry: string) {
      await writeFile(
        join(bin, "visp"),
        `#!${process.execPath}\nconst {spawnSync}=require("node:child_process");\nconst child=spawnSync(process.execPath,[${JSON.stringify(entry)},...process.argv.slice(2)],{stdio:"inherit"});\nprocess.exit(child.status ?? 1);\n`,
        { mode: 0o755 },
      );
    }
    await pointGuardAt(join(previous, "cli.js"));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
    async function install(entry: string) {
      await promisify(execFile)(
        process.execPath,
        [entry, "--project", workspace.root, "install", "--hooks", "git", "--json"],
        { env },
      );
    }
    await install(join(previous, "cli.js"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(previous, "cli.js"), "--project", workspace.root, "serve", "--mcp"],
      env,
      stderr: "pipe",
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("visp_doctor");
    const before = await client.callTool({ name: "visp_doctor", arguments: {} });
    expect(before.structuredContent).toMatchObject({
      ok: true,
      data: { runtime: { version: current.version, buildId: previousBuild } },
    });
    expect(JSON.stringify(before.structuredContent)).not.toContain("VISP runtime mismatch");
    expect(before.structuredContent).toMatchObject({
      data: {
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "installed runtime", status: "ok" }),
          expect.objectContaining({ name: "harness assets", status: "ok" }),
        ]),
      },
    });
    await pointGuardAt(resolve("dist/cli.js"));
    await install(resolve("dist/cli.js"));
    const after = await client.callTool({ name: "visp_doctor", arguments: {} });
    expect(after.structuredContent).toMatchObject({
      ok: true,
      data: { verdict: "unhealthy", runtime: { buildId: previousBuild } },
    });
    expect(JSON.stringify(after.structuredContent)).toContain("VISP runtime mismatch");
    expect(JSON.stringify(after.structuredContent)).toContain(current.buildId);
    const refused = await client.callTool({ name: "visp_work", arguments: {} });
    expect(refused.structuredContent).toMatchObject({
      ok: false,
      error: { code: "RUNTIME_MISMATCH" },
    });
    const cli = await promisify(execFile)(
      process.execPath,
      [resolve("dist/cli.js"), "--project", workspace.root, "doctor", "--json"],
      { env },
    );
    expect(JSON.parse(cli.stdout)).toMatchObject({
      ok: true,
      data: { runtime: { version: current.version, buildId: current.buildId } },
    });
  } finally {
    await client.close();
    await workspace.destroy();
  }
}, 30000);
