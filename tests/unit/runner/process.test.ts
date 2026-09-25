import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeStream } from "../../../src/runner/process.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-runner-process-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("bounded runner processes", () => {
  it("terminates descendant commands when an attempt times out", async () => {
    const child = join(root, "child.cjs");
    const heartbeat = join(root, "heartbeat");
    await writeFile(
      child,
      "const fs=require('node:fs'); fs.appendFileSync(process.argv[2],'.'); console.log('ready'); setInterval(()=>fs.appendFileSync(process.argv[2],'.'),20);",
    );
    const parent = join(root, "parent.cjs");
    await writeFile(
      parent,
      `const {spawn}=require('node:child_process'); spawn(process.execPath,[${JSON.stringify(child)},${JSON.stringify(heartbeat)}],{stdio:['ignore','inherit','inherit']}); setInterval(()=>{},1000);`,
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = await executeStream({
        file: process.execPath,
        args: [parent],
        cwd: root,
        input: "",
        timeoutMs: 200,
        onLine: (line) => {
          if (line === "ready") vi.advanceTimersByTime(200);
          return undefined;
        },
      });
      expect(result.reason).toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
    const stopped = await readFile(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(heartbeat, "utf8")).toBe(stopped);
  });

  it("cancels descendant commands after the child confirms it has started", async () => {
    const child = join(root, "cancel-child.cjs");
    const heartbeat = join(root, "cancel-heartbeat");
    await writeFile(
      child,
      "const fs=require('node:fs'); fs.appendFileSync(process.argv[2],'.'); console.log('ready'); setInterval(()=>fs.appendFileSync(process.argv[2],'.'),20);",
    );
    const parent = join(root, "cancel-parent.cjs");
    await writeFile(
      parent,
      `const {spawn}=require('node:child_process'); spawn(process.execPath,[${JSON.stringify(child)},${JSON.stringify(heartbeat)}],{stdio:['ignore','inherit','inherit']}); setInterval(()=>{},1000);`,
    );
    const controller = new AbortController();
    const result = await executeStream({
      file: process.execPath,
      args: [parent],
      cwd: root,
      input: "",
      timeoutMs: 3000,
      signal: controller.signal,
      onLine: (line) => {
        if (line === "ready") controller.abort();
        return undefined;
      },
    });
    expect(result.reason).toBe("cancelled");
    const stopped = await readFile(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(heartbeat, "utf8")).toBe(stopped);
  });

  it("stops oversized lines and bounds retained stderr", async () => {
    const oversized = await executeStream({
      file: process.execPath,
      args: [
        "-e",
        "process.stderr.write('e'.repeat(100000)); process.stdout.write('x'.repeat(3*1024*1024)); setInterval(()=>{},1000)",
      ],
      cwd: root,
      input: "",
      timeoutMs: 2000,
      onLine: () => undefined,
    });
    expect(oversized.reason).toBe("output-limit");
    expect(oversized.stderr.length).toBeLessThanOrEqual(64 * 1024);
  });
});
