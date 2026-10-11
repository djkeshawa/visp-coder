import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TestProject } from "../support/project.js";

const CLI = resolve(process.cwd(), "dist/cli.js");

interface Started {
  readonly url: string;
  readonly port: number;
  readonly pid: number;
  readonly reused: boolean;
}

let project: TestProject;
let runtime: string;
let child: ChildProcess | undefined;

beforeEach(async () => {
  project = await TestProject.create();
  project.run("init", "--harness", "generic");
  runtime = await mkdtemp(join(tmpdir(), "visp-ui-runtime-"));
});

afterEach(async () => {
  child?.kill("SIGTERM");
  child = undefined;
  await project.destroy();
  await rm(runtime, { recursive: true, force: true });
});

/** The lease lives in a private runtime directory, never in the repository. */
const env = () => ({ ...project.env(), XDG_RUNTIME_DIR: runtime });

function startDashboard(): Promise<Started> {
  return new Promise((resolvePromise, reject) => {
    child = spawn("node", [CLI, "--project", project.root, "ui", "--no-open", "--json"], {
      env: env(),
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split("\n")[0];
      if (output.includes("\n") && line) {
        const envelope = JSON.parse(line) as { ok: boolean; data: Started };
        if (envelope.ok) resolvePromise(envelope.data);
        else reject(new Error(line));
      }
    });
    child.on("exit", (code) => reject(new Error(`visp ui exited with ${code}: ${output}`)));
  });
}

function runOnce(...args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("node", [CLI, "--project", project.root, ...args], {
      env: env(),
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (error) {
    const failure = error as { status: number; stdout: string };
    return { status: failure.status, stdout: failure.stdout };
  }
}

it("prints the address as one JSON envelope and keeps serving on loopback", async () => {
  const started = await startDashboard();
  expect(started.reused).toBe(false);
  expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{40,}$/);
  const ping = await fetch(`http://127.0.0.1:${started.port}/api/v1/ping`);
  expect(ping.status).toBe(200);
  const unsigned = await fetch(`http://127.0.0.1:${started.port}/api/v1/overview`);
  expect(unsigned.status).toBe(401);
});

it("reopens the running dashboard instead of starting a second one", async () => {
  const first = await startDashboard();
  const second = runOnce("ui", "--no-open", "--json");
  expect(second.status).toBe(0);
  expect(JSON.parse(second.stdout)).toMatchObject({
    ok: true,
    data: { reused: true, port: first.port, url: first.url },
  });
});

it("removes its lease when stopped", async () => {
  await startDashboard();
  expect(await readdir(join(runtime, (await readdir(runtime))[0] ?? ""))).toHaveLength(1);
  const exited = new Promise((done) => child?.once("exit", done));
  child?.kill("SIGTERM");
  await exited;
  child = undefined;
  const [dir] = await readdir(runtime);
  expect(await readdir(join(runtime, dir ?? ""))).toHaveLength(0);
});

it("refuses a bad port and a repository without VISP", async () => {
  const badPort = runOnce("ui", "--no-open", "--json", "--port", "http");
  expect(badPort.status).not.toBe(0);
  expect(JSON.parse(badPort.stdout)).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  const bare = await TestProject.create();
  try {
    const result = execFileSync("node", [CLI, "--project", bare.root, "ui", "--json"], {
      env: env(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    throw new Error(`expected a refusal, got ${result}`);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "NOT_INITIALIZED" } });
  } finally {
    await bare.destroy();
  }
});
