import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCommand, resolveCommand, run } from "../../../src/core/exec.js";
import { prepareCommand } from "../../../src/core/windows-command.js";

describe("parseCommand", () => {
  it("splits a plain command into an argv vector", () => {
    const result = parseCommand("pnpm test");
    expect(result.ok && result.value).toEqual(["pnpm", "test"]);
  });

  it("keeps quoted segments together", () => {
    const result = parseCommand('node -e "a b"');
    expect(result.ok && result.value).toEqual(["node", "-e", "a b"]);
  });

  it("accepts Windows path separators as literal argv content", () => {
    expect(parseCommand("node test\\a.test.mjs")).toEqual({
      ok: true,
      value: ["node", "test\\a.test.mjs"],
    });
  });

  it("refuses shell syntax rather than passing it to a shell", () => {
    for (const command of ["rm -rf / && echo done", "cat a | grep b", "echo $HOME"]) {
      const result = parseCommand(command);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses an empty command", () => {
    expect(parseCommand("   ").ok).toBe(false);
  });
});

it("resolves Windows npm shims through PATHEXT and escapes metacharacters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "visp-windows-command-"));
  try {
    await writeFile(join(directory, "npm.cmd"), "@echo off\r\n");
    const prepared = prepareCommand(
      "npm",
      ["test", "a&b", "%USERPROFILE%"],
      {
        PATH: directory,
        PATHEXT: ".cmd;.exe",
      },
      "win32",
    );
    expect(prepared.file).toBe("cmd.exe");
    expect(prepared.windowsVerbatimArguments).toBe(true);
    expect(prepared.args).toEqual(["/d", "/s", "/c", expect.stringContaining("^&")]);
    expect(prepared.args[3]).toContain("^%USERPROFILE^%");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("run", () => {
  it("retains bounded head and tail output without killing a verbose check", async () => {
    const result = await run(
      process.execPath,
      [
        "-e",
        "console.log('HEAD'); process.stdout.write('x'.repeat(9 * 1024 * 1024)); console.log('TAIL');",
      ],
      { cwd: process.cwd() },
    );
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
    if (!result.ok) return;
    expect(result.value.stdout).toContain("HEAD");
    expect(result.value.stdout).toContain("TAIL");
    expect(result.value.stdout).toContain("output truncated");
    expect(result.value.stdout.length).toBeLessThan(8 * 1024 * 1024 + 100);
  });

  it("does not wait for inherited pipes after the direct child exits", async () => {
    const result = await run(
      process.execPath,
      [
        "-e",
        `
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], {stdio: 'inherit'});
      child.unref();
    `,
      ],
      { cwd: process.cwd(), timeoutMs: 1200 },
    );
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, timedOut: false } });
    if (result.ok) expect(result.value.durationMs).toBeLessThan(1000);
  });

  it("aborts a running command promptly", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: process.cwd(),
        signal: controller.signal,
        timeoutMs: 1200,
      });
      expect(result).toMatchObject({ ok: true, value: { aborted: true, timedOut: false } });
      if (result.ok) expect(result.value.durationMs).toBeLessThan(1000);
    } finally {
      clearTimeout(timer);
    }
  });

  it("captures stdout and a zero exit code", async () => {
    const result = await run("node", ["-e", "process.stdout.write('hi')"], {
      cwd: process.cwd(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdout).toBe("hi");
    expect(result.value.exitCode).toBe(0);
  });

  it("reports a non-zero exit code as a value, not a throw", async () => {
    const result = await run("node", ["-e", "process.exit(3)"], { cwd: process.cwd() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(3);
  });

  /**
   * A binary that is not there did not run, and must not come back looking like
   * one that ran and failed — evidence would then record "the tests failed"
   * when the test runner was never installed.
   */
  it("errors when the executable does not exist", async () => {
    const result = await run("visp-no-such-binary", [], { cwd: process.cwd() });
    expect(result).toMatchObject({ ok: false, error: { details: { errno: "ENOENT" } } });
  });

  it.each([
    ["node\0", []],
    ["node", ["bad\0argument"]],
  ] as const)("returns a refusal for invalid process input %s", async (file, args) => {
    await expect(run(file, args, { cwd: process.cwd() })).resolves.toMatchObject({
      ok: false,
      error: { code: "COMMAND_FAILED" },
    });
  });

  it("marks a command that exceeded its timeout", async () => {
    const result = await run("node", ["-e", "setTimeout(() => {}, 5000)"], {
      cwd: process.cwd(),
      timeoutMs: 150,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timedOut).toBe(true);
  });
});

it("preserves an explicit empty argv argument", () => {
  expect(resolveCommand(["node", "script.js", "", "value"])).toEqual({
    ok: true,
    value: ["node", "script.js", "", "value"],
  });
});

it("parses quoted option values without splitting the argument", () => {
  expect(parseCommand('runner --name="two words"')).toEqual({
    ok: true,
    value: ["runner", "--name=two words"],
  });
});

it.each(["runner 'unterminated", 'runner "unterminated', '"" argument'])(
  "refuses malformed command %s",
  (command) => {
    expect(parseCommand(command).ok).toBe(false);
  },
);

it("concatenates quoted segments and keeps empty string arguments", () => {
  expect(parseCommand(`runner pre"two words"post '' ""`)).toEqual({
    ok: true,
    value: ["runner", "pretwo wordspost", "", ""],
  });
});

it("refuses an empty executable instead of shifting the following argument into its place", () => {
  expect(resolveCommand(["", "node"]).ok).toBe(false);
});
