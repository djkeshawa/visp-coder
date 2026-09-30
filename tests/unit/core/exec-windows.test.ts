import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../src/core/exec.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../../src/core/windows-command.js", () => ({
  prepareCommand: (file: string, args: readonly string[]) => ({ file, args: [...args] }),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform");
let child: ChildProcess;
let killer: ChildProcess;

function fakeProcess(pid: number | undefined): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    exitCode: null,
    signalCode: null,
    pid,
    kill: vi.fn(),
  }) as unknown as ChildProcess;
}

const taskkillCalls = () =>
  vi.mocked(spawn).mock.calls.filter(([file]) => file === "taskkill") as unknown as [
    string,
    string[],
    Record<string, unknown>,
  ][];

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
  child = fakeProcess(4242);
  killer = fakeProcess(4243);
  vi.mocked(spawn).mockImplementation(((file: string) =>
    file === "taskkill" ? killer : child) as unknown as typeof spawn);
});
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

describe("Windows process-tree kill", () => {
  it("ends the whole tree with taskkill when a command is aborted", async () => {
    const controller = new AbortController();
    const running = run("npm", ["test"], { cwd: process.cwd(), signal: controller.signal });
    controller.abort();
    await expect(running).resolves.toMatchObject({ ok: true, value: { aborted: true } });
    expect(taskkillCalls()[0]?.[1]).toEqual(["/pid", "4242", "/T", "/F"]);
    expect(taskkillCalls()[0]?.[2]).toMatchObject({ stdio: "ignore", windowsHide: true });
  });

  it("does not target a pid whose command already exited", async () => {
    const running = run("npm", ["test"], { cwd: process.cwd() });
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await expect(running).resolves.toMatchObject({ ok: true, value: { exitCode: 0 } });
    expect(taskkillCalls()).toEqual([]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to killing the shim when taskkill cannot start", async () => {
    const controller = new AbortController();
    const running = run("npm", ["test"], { cwd: process.cwd(), signal: controller.signal });
    controller.abort();
    killer.emit("error", new Error("spawn taskkill ENOENT"));
    await running;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back to killing the shim when taskkill exits non-zero and the command is still alive", async () => {
    const controller = new AbortController();
    const running = run("npm", ["test"], { cwd: process.cwd(), signal: controller.signal });
    controller.abort();
    killer.emit("exit", 128, null);
    await running;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not signal a command that exited before taskkill reported failure", async () => {
    const controller = new AbortController();
    const running = run("npm", ["test"], { cwd: process.cwd(), signal: controller.signal });
    controller.abort();
    Object.assign(child, { exitCode: 0 });
    killer.emit("exit", 128, null);
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await running;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to killing the shim when taskkill throws while starting", async () => {
    vi.mocked(spawn).mockImplementation(((file: string) => {
      if (file === "taskkill") throw new Error("spawn EAGAIN");
      return child;
    }) as unknown as typeof spawn);
    const controller = new AbortController();
    const running = run("npm", ["test"], { cwd: process.cwd(), signal: controller.signal });
    controller.abort();
    await running;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
