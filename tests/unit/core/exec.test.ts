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

  it("passes quoted test glob and pytest IDs literally", () => {
    expect(parseCommand('node --test "test/**/*.test.mjs"')).toEqual({
      ok: true,
      value: ["node", "--test", "test/**/*.test.mjs"],
    });
    expect(parseCommand("pytest 'test_api.py::test_case[a]' ")).toEqual({
      ok: true,
      value: ["pytest", "test_api.py::test_case[a]"],
    });
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
