import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { err, ok } from "../../../src/core/result.js";
import { TestWorkspace } from "../support/workspace.js";

const runner = vi.hoisted(() => ({ override: undefined as undefined | (() => unknown) }));
vi.mock("../../../src/core/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/exec.js")>();
  return {
    ...actual,
    run: (...args: Parameters<typeof actual.run>) =>
      runner.override ? runner.override() : actual.run(...args),
  };
});
const { recordEarlierRequests } = await import("../../../src/memory/memory-service.js");

let workspace: TestWorkspace;
beforeEach(async () => {
  runner.override = undefined;
  workspace = await TestWorkspace.create();
});
afterEach(() => {
  runner.override = undefined;
});

function earlier(request: string) {
  return [{ feature: "001-example", goal: "Remember choices", originalRequest: request }];
}

/** A memory command that appends each `decision` text to a log and exits with the given code. */
async function fake(
  exitCode: number,
): Promise<{ command: string; calls: () => Promise<string[]> }> {
  const command = join(workspace.root, ".fake-visp-memory");
  const log = join(workspace.root, ".memory-calls");
  await writeFile(
    command,
    `#!/bin/sh\nif [ "$1" = decision ]; then printf '%s\\n' "$2" >> '${log}'; exit ${exitCode}; fi\n`,
  );
  await chmod(command, 0o755);
  return {
    command,
    calls: async () =>
      (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== ""),
  };
}

it("passes a bulleted chunk without its leading dash, which the tool would read as an option", async () => {
  const memory = await fake(0);
  await recordEarlierRequests(
    await workspace.state(),
    memory.command,
    earlier("- Names are unique within a project.\n- Ids are never reused after removal."),
  );
  expect(await memory.calls()).toEqual([
    "Names are unique within a project.",
    "Ids are never reused after removal.",
  ]);
});

it("keeps numbered items verbatim", async () => {
  const memory = await fake(0);
  await recordEarlierRequests(
    await workspace.state(),
    memory.command,
    earlier("1. An archived item cannot be reserved.\n2. Items hold at most 10000 units."),
  );
  expect(await memory.calls()).toEqual([
    "1. An archived item cannot be reserved.",
    "2. Items hold at most 10000 units.",
  ]);
});

it("still guards text that starts with a dash after the marker is removed", async () => {
  const memory = await fake(0);
  await recordEarlierRequests(
    await workspace.state(),
    memory.command,
    earlier("- --force is never allowed on the archive endpoint."),
  );
  expect(await memory.calls()).toEqual([
    "Stated: --force is never allowed on the archive endpoint.",
  ]);
});

it("stops after two failing chunks and leaves the feature for the next attempt", async () => {
  const memory = await fake(1);
  const result = await recordEarlierRequests(
    await workspace.state(),
    memory.command,
    earlier(
      "- The first decision must be recorded.\n- The second decision must be recorded.\n- The third decision must be recorded.\n- The fourth decision must be recorded.",
    ),
  );
  expect(result).toEqual(ok(undefined));
  expect(await memory.calls()).toHaveLength(2);
});

it("stops at the first chunk when the tool times out", async () => {
  const run = vi.fn(() =>
    Promise.resolve(
      ok({ command: "memory", exitCode: 1, stdout: "", stderr: "", timedOut: true, durationMs: 1 }),
    ),
  );
  runner.override = run;
  const result = await recordEarlierRequests(
    await workspace.state(),
    "memory",
    earlier("- The first decision must be recorded.\n- The second decision must be recorded."),
  );
  expect(result).toEqual(ok(undefined));
  expect(run).toHaveBeenCalledTimes(1);
});

it("stops at the first chunk when the tool cannot start", async () => {
  const run = vi.fn(() => Promise.resolve(err({ code: "COMMAND_FAILED", message: "ENOENT" })));
  runner.override = run;
  const result = await recordEarlierRequests(
    await workspace.state(),
    "memory",
    earlier("- The first decision must be recorded.\n- The second decision must be recorded."),
  );
  expect(result).toEqual(ok(undefined));
  expect(run).toHaveBeenCalledTimes(1);
});
