import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventJournal } from "../../../src/runner/artifacts.js";
import type { RunnerHost, RunnerSpec } from "../../../src/runner/contracts.js";
import { HostStreamState } from "../../../src/runner/stream-state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function requiredTool(host: RunnerHost): string {
  return host === "claude" ? "mcp__visp__visp_next" : "visp.next";
}

async function stateFor(
  host: RunnerHost = "claude",
  requirements: { requiredCommands?: string[][]; requiredTools?: string[] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "visp-stream-state-"));
  roots.push(root);
  const events = join(root, "events");
  await mkdir(events);
  const spec: RunnerSpec = {
    schemaVersion: 1,
    id: "stream-observation",
    repository: root,
    revision: "a".repeat(40),
    task: { feature: "001-feature", task: "T001" },
    prompt: "Observe tool execution",
    host: {
      kind: host,
      model: "small",
      executable: process.execPath,
      executableSha256: "a".repeat(64),
      version: "fixture",
    },
    permissions: { mode: "workspace-write", requireSandbox: false },
    harness: {
      mode: "visp",
      files: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
      requiredTools: requirements.requiredTools ?? [requiredTool(host)],
      requiredHooks: [],
      requiredCommands: requirements.requiredCommands,
    },
    budget: {
      maxDurationMs: 1000,
      maxEstimatedUsd: 1,
      studyMaxEstimatedUsd: 1,
      studyApprovalId: "fixture",
      monetaryEnforcement: "estimated",
      prices: {
        source: "fixture",
        capturedAt: "2026-09-05T00:00:00Z",
        currency: "USD",
        model: "small",
        uncachedInputPerMillion: 1,
        cachedInputPerMillion: 1,
        cacheWriteInputPerMillion: 1,
        outputPerMillion: 1,
      },
    },
    assignment: {
      study: "fixture",
      scenario: "observations",
      repositoryGroup: "fixture",
      arm: "ablation",
      split: "pilot",
      repetition: 0,
      order: 0,
    },
  };
  return new HostStreamState(spec, new EventJournal(events, "run", "manifest"));
}

function observed(state: HostStreamState): boolean {
  state.finish({ exitCode: 0, reason: "exited", stderr: "" });
  return !state.diagnostics.includes(
    `Required tool was not observed: ${requiredTool(state.spec.host.kind)}`,
  );
}

function assistant(...calls: { id: string; name: string }[]): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: calls.map((call) => ({ type: "tool_use", ...call })) },
  });
}
function user(...results: { tool_use_id: string; is_error?: boolean }[]): string {
  return JSON.stringify({
    type: "user",
    message: { content: results.map((result) => ({ type: "tool_result", ...result })) },
  });
}
function codex(type: "started" | "completed", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: `item.${type}`,
    item: {
      id: "call-1",
      type: "mcp_tool_call",
      server: "visp",
      tool: "next",
      status: type === "started" ? "in_progress" : "completed",
      ...extra,
    },
  });
}

function claudeBash(command: string, id = "command-1"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Bash", id, input: { command } }],
    },
  });
}

function claudeResult(id = "command-1", is_error?: boolean): string {
  return JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          ...(is_error === undefined ? {} : { is_error }),
        },
      ],
    },
  });
}

function codexCommand(
  type: "started" | "completed",
  command = "visp next --json",
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: `item.${type}`,
    item: {
      id: "command-1",
      type: "command_execution",
      command,
      status: type === "started" ? "in_progress" : "completed",
      ...(type === "completed" ? { exit_code: 0 } : {}),
      ...extra,
    },
  });
}

function commandObserved(state: HostStreamState): boolean {
  state.finish({ exitCode: 0, reason: "exited", stderr: "" });
  return !state.diagnostics.some((diagnostic) =>
    diagnostic.startsWith("Required command was not observed:"),
  );
}

describe("host stream tool observations", () => {
  it("does not count the Claude initialization inventory", async () => {
    const state = await stateFor();
    state.accept(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session",
        tools: [requiredTool("claude")],
      }),
    );
    expect(observed(state)).toBe(false);
  });

  it.each([false, undefined])(
    "counts a matching successful Claude result with is_error=%s",
    async (is_error) => {
      const state = await stateFor();
      state.accept(assistant({ id: "call-1", name: requiredTool("claude") }));
      state.accept(user({ tool_use_id: "call-1", is_error }));
      expect(observed(state)).toBe(true);
    },
  );

  it("does not count a denied call or a later duplicate success for the same ID", async () => {
    const state = await stateFor();
    state.accept(assistant({ id: "denied", name: requiredTool("claude") }));
    state.accept(user({ tool_use_id: "denied", is_error: true }));
    state.accept(user({ tool_use_id: "denied", is_error: false }));
    expect(observed(state)).toBe(false);
  });

  it("does not count unmatched or unfinished calls", async () => {
    const state = await stateFor();
    state.accept(user({ tool_use_id: "missing", is_error: false }));
    state.accept(assistant({ id: "pending", name: requiredTool("claude") }));
    expect(observed(state)).toBe(false);
  });

  it("does not credit an ambiguous duplicate pending ID", async () => {
    const state = await stateFor();
    state.accept(assistant({ id: "duplicate", name: requiredTool("claude") }));
    state.accept(assistant({ id: "duplicate", name: "Read" }));
    state.accept(user({ tool_use_id: "duplicate", is_error: false }));
    expect(observed(state)).toBe(false);
    expect(state.diagnostics.join("\n")).toMatch(/duplicate/i);
  });

  it("processes every call and result in a parallel tool message", async () => {
    const state = await stateFor();
    state.accept(
      assistant({ id: "read", name: "Read" }, { id: "next", name: requiredTool("claude") }),
    );
    state.accept(
      user({ tool_use_id: "read", is_error: false }, { tool_use_id: "next", is_error: false }),
    );
    expect(observed(state)).toBe(true);
  });

  it("does not reuse failed IDs after more than 256 completed calls", async () => {
    const state = await stateFor();
    for (let batch = 0; batch < 3; batch++) {
      const ids = Array.from({ length: 100 }, (_, index) => `read-${batch * 100 + index}`);
      state.accept(assistant(...ids.map((id) => ({ id, name: "Read" }))));
      state.accept(user(...ids.map((tool_use_id) => ({ tool_use_id, is_error: true }))));
    }
    state.accept(assistant({ id: "read-299", name: requiredTool("claude") }));
    state.accept(user({ tool_use_id: "read-299", is_error: false }));
    expect(observed(state)).toBe(false);
  });

  it("counts a paired successful Codex MCP call", async () => {
    const state = await stateFor("codex");
    state.accept(codex("started"));
    state.accept(codex("completed"));
    expect(observed(state)).toBe(true);
  });

  it.each([
    { status: "failed" },
    { error: { message: "permission denied" } },
    { result: { isError: true } },
  ])("does not count a failed Codex MCP result: %j", async (failure) => {
    const state = await stateFor("codex");
    state.accept(codex("started"));
    state.accept(codex("completed", failure));
    expect(observed(state)).toBe(false);
  });

  it("does not count a duplicate Codex completion after failure", async () => {
    const state = await stateFor("codex");
    state.accept(codex("started"));
    state.accept(codex("completed", { status: "failed" }));
    state.accept(codex("completed"));
    expect(observed(state)).toBe(false);
  });

  it("does not relabel a pending Codex call through its completion", async () => {
    const state = await stateFor("codex");
    state.accept(codex("started", { tool: "other" }));
    state.accept(codex("completed"));
    expect(observed(state)).toBe(false);
  });

  it("counts a correlated successful Claude Bash command", async () => {
    const state = await stateFor("claude", {
      requiredTools: [],
      requiredCommands: [["visp", "next", "--json"]],
    });
    state.accept(claudeBash("visp next --json"));
    state.accept(claudeResult());
    expect(commandObserved(state)).toBe(true);
  });

  it("counts the native quoted /bin/bash -lc wrapper", async () => {
    const state = await stateFor("claude", {
      requiredTools: [],
      requiredCommands: [["visp", "next", "--json"]],
    });
    state.accept(claudeBash(`/bin/bash -lc 'visp next --json'`));
    state.accept(claudeResult());
    expect(commandObserved(state)).toBe(true);
  });

  it.each([
    "visp status",
    "echo visp next --json",
    "visp next --json | cat",
    "visp next --json && echo done",
    "visp $(echo next) --json",
    "visp next --json > result.json",
    "cd /repo && visp next --json",
    "VISP_MODE=1 visp next --json",
    "/bin/bash -c 'visp next --json'",
  ])("does not credit a false command match: %s", async (command) => {
    const state = await stateFor("claude", {
      requiredTools: [],
      requiredCommands: [["visp", "next", "--json"]],
    });
    state.accept(claudeBash(command));
    state.accept(claudeResult());
    expect(commandObserved(state)).toBe(false);
  });

  it("does not credit a denied Claude Bash result or an unfinished call", async () => {
    const denied = await stateFor("claude", {
      requiredTools: [],
      requiredCommands: [["visp", "next", "--json"]],
    });
    denied.accept(claudeBash("visp next --json"));
    denied.accept(claudeResult("command-1", true));
    expect(commandObserved(denied)).toBe(false);

    const unfinished = await stateFor("claude", {
      requiredTools: [],
      requiredCommands: [["visp", "next", "--json"]],
    });
    unfinished.accept(claudeBash("visp next --json"));
    expect(commandObserved(unfinished)).toBe(false);
  });

  it("does not credit an ambiguous duplicate Claude command ID", async () => {
    const state = await stateFor("claude", {
      requiredTools: [],
      requiredCommands: [["visp", "next", "--json"]],
    });
    state.accept(claudeBash("visp next --json"));
    state.accept(claudeBash("visp next --json", "command-1"));
    state.accept(claudeResult());
    expect(commandObserved(state)).toBe(false);
    expect(state.diagnostics.join("\n")).toMatch(/duplicate/i);
  });

  it("does not credit a same-message Bash and non-Bash ID collision", async () => {
    const state = await stateFor("claude", {
      requiredTools: [],
      requiredCommands: [["visp", "next", "--json"]],
    });
    state.accept(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              id: "command-1",
              input: { command: "visp next --json" },
            },
            { type: "tool_use", name: "Read", id: "command-1" },
          ],
        },
      }),
    );
    state.accept(claudeResult());
    expect(commandObserved(state)).toBe(false);
    expect(state.diagnostics.join("\n")).toMatch(/duplicate|reuse/i);
  });

  it.each(["read-first", "bash-first"])(
    "fails closed when a Claude command and non-Bash tool share an identity (%s)",
    async (order) => {
      const state = await stateFor("claude", {
        requiredTools: [],
        requiredCommands: [["visp", "next", "--json"]],
      });
      if (order === "read-first") {
        state.accept(assistant({ id: "command-1", name: "Read" }));
        state.accept(claudeBash("visp next --json"));
      } else {
        state.accept(claudeBash("visp next --json"));
        state.accept(assistant({ id: "command-1", name: "Read" }));
      }
      state.accept(claudeResult());
      expect(commandObserved(state)).toBe(false);
      expect(state.diagnostics.join("\n")).toMatch(/duplicate|reuse/i);
    },
  );

  it("does not credit lifecycle events that arrive after a terminal result", async () => {
    const state = await stateFor("claude", {
      requiredTools: [requiredTool("claude")],
      requiredCommands: [["visp", "next", "--json"]],
    });
    state.accept(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "session",
      }),
    );
    state.accept(claudeBash("visp next --json"));
    state.accept(claudeResult());
    state.finish({ exitCode: 0, reason: "exited", stderr: "" });
    expect(state.diagnostics).toContain(
      `Required tool was not observed: ${requiredTool("claude")}`,
    );
    expect(state.diagnostics).toContain(
      'Required command was not observed: ["visp","next","--json"]',
    );
    expect(state.diagnostics).toContain("Host emitted evidence after terminal result");
  });

  it("requires a successful Codex command execution with exit_code zero", async () => {
    const state = await stateFor("codex", {
      requiredTools: [],
      requiredCommands: [["visp", "next", "--json"]],
    });
    state.accept(codexCommand("started"));
    state.accept(codexCommand("completed"));
    expect(commandObserved(state)).toBe(true);

    const failed = await stateFor("codex", {
      requiredTools: [],
      requiredCommands: [["visp", "next", "--json"]],
    });
    failed.accept(codexCommand("started"));
    failed.accept(codexCommand("completed", "visp next --json", { exit_code: 1 }));
    expect(commandObserved(failed)).toBe(false);
  });

  it("does not relabel a pending Codex command through its completion", async () => {
    const state = await stateFor("codex", {
      requiredTools: [],
      requiredCommands: [["visp", "next", "--json"]],
    });
    state.accept(codexCommand("started", "visp status"));
    state.accept(codexCommand("completed", "visp next --json"));
    expect(commandObserved(state)).toBe(false);
  });

  it.each(["mcp-first", "command-first"])(
    "fails closed when a Codex command and MCP tool share an identity (%s)",
    async (order) => {
      const state = await stateFor("codex", {
        requiredTools: [],
        requiredCommands: [["visp", "next", "--json"]],
      });
      if (order === "mcp-first") {
        state.accept(codex("started"));
        state.accept(codexCommand("started", "visp next --json", { id: "call-1" }));
      } else {
        state.accept(codexCommand("started", "visp next --json", { id: "call-1" }));
        state.accept(codex("started"));
      }
      state.accept(codexCommand("completed", "visp next --json", { id: "call-1" }));
      expect(commandObserved(state)).toBe(false);
      expect(state.diagnostics.join("\n")).toMatch(/reuse|identity/i);
    },
  );
});
