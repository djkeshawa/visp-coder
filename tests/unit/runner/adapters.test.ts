import { describe, expect, it } from "vitest";
import { adapterFor } from "../../../src/runner/adapters.js";
import { parseObservedCommand } from "../../../src/runner/command-observation.js";
import { runnerSpecSchema } from "../../../src/runner/contracts.js";

describe("runner host adapters", () => {
  it("restricts explicit allowedTools by host and read-only mode", () => {
    const base = {
      schemaVersion: 1,
      id: "run",
      repository: "/repo",
      revision: "a".repeat(40),
      task: { feature: "001-feature", task: "T001" },
      prompt: "prompt",
      host: {
        kind: "claude",
        executable: "/bin/host",
        executableSha256: "a".repeat(64),
        version: "1",
        model: "small",
      },
      permissions: { mode: "workspace-write", requireSandbox: false },
      budget: {
        maxDurationMs: 1000,
        maxEstimatedUsd: 1,
        studyMaxEstimatedUsd: 1,
        studyApprovalId: "approval",
        monetaryEnforcement: "estimated",
        prices: {
          source: "test",
          capturedAt: "2026-01-01T00:00:00Z",
          currency: "USD",
          model: "small",
          uncachedInputPerMillion: 1,
          cachedInputPerMillion: 1,
          cacheWriteInputPerMillion: 1,
          outputPerMillion: 1,
        },
      },
      harness: { mode: "disabled", files: [], requiredTools: [], requiredHooks: [] },
      assignment: {
        study: "study",
        scenario: "scenario",
        repositoryGroup: "group",
        arm: "ablation",
        split: "pilot",
        repetition: 0,
        order: 0,
      },
    } as const;
    expect(
      runnerSpecSchema.parse({
        ...base,
        permissions: { ...base.permissions, allowedTools: ["Edit"] },
      }),
    ).toBeTruthy();
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        permissions: { mode: "read-only", requireSandbox: false, allowedTools: ["Edit"] },
      }),
    ).toThrow(/read-only/i);
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        host: { ...base.host, kind: "codex" },
        permissions: { ...base.permissions, allowedTools: ["Read"] },
      }),
    ).toThrow(/only for Claude/i);
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        permissions: { ...base.permissions, allowedTools: ["\u0000"] },
      }),
    ).toThrow(/control/i);
  });

  it("accepts exact command requirements for VISP and rejects invalid declarations", () => {
    const base = {
      schemaVersion: 1,
      id: "run",
      repository: "/repo",
      revision: "a".repeat(40),
      task: { feature: "001-feature", task: "T001" },
      prompt: "prompt",
      host: {
        kind: "claude",
        executable: "/bin/host",
        executableSha256: "a".repeat(64),
        version: "1",
        model: "small",
      },
      permissions: { mode: "workspace-write", requireSandbox: false },
      budget: {
        maxDurationMs: 1000,
        maxEstimatedUsd: 1,
        studyMaxEstimatedUsd: 1,
        studyApprovalId: "approval",
        monetaryEnforcement: "estimated",
        prices: {
          source: "test",
          capturedAt: "2026-01-01T00:00:00Z",
          currency: "USD",
          model: "small",
          uncachedInputPerMillion: 1,
          cachedInputPerMillion: 1,
          cacheWriteInputPerMillion: 1,
          outputPerMillion: 1,
        },
      },
      harness: { mode: "disabled", files: [], requiredTools: [], requiredHooks: [] },
      assignment: {
        study: "study",
        scenario: "scenario",
        repositoryGroup: "group",
        arm: "ablation",
        split: "pilot",
        repetition: 0,
        order: 0,
      },
    } as const;
    const command = ["visp", "next", "--json"];
    expect(
      runnerSpecSchema.parse({
        ...base,
        harness: {
          mode: "visp",
          files: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
          requiredTools: [],
          requiredHooks: [],
          requiredCommands: [command],
        },
      }),
    ).toMatchObject({ harness: { requiredCommands: [command] } });
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        harness: {
          mode: "visp",
          files: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
          requiredTools: [],
          requiredHooks: [],
          requiredCommands: [],
        },
      }),
    ).toThrow(/tool|command/i);
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        harness: { ...base.harness, requiredCommands: [command] },
      }),
    ).toThrow(/disabled/i);
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        harness: {
          mode: "visp",
          files: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
          requiredTools: [],
          requiredHooks: [],
          requiredCommands: [[]],
        },
      }),
    ).toThrow(/at least|empty|array/i);
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        harness: {
          mode: "visp",
          files: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
          requiredTools: [],
          requiredHooks: [],
          requiredCommands: Array.from({ length: 65 }, () => command),
        },
      }),
    ).toThrow(/64|at most/i);
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        harness: {
          mode: "visp",
          files: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
          requiredTools: [],
          requiredHooks: [],
          requiredCommands: [[...Array.from({ length: 257 }, () => "arg")]],
        },
      }),
    ).toThrow(/256|at most/i);
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        harness: {
          mode: "visp",
          files: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
          requiredTools: [],
          requiredHooks: [],
          requiredCommands: [["a".repeat(4097)]],
        },
      }),
    ).toThrow(/4096|at most/i);
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        harness: {
          mode: "visp",
          files: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
          requiredTools: [],
          requiredHooks: [],
          requiredCommands: [["visp\u0000"]],
        },
      }),
    ).toThrow(/control/i);
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        harness: {
          mode: "visp",
          files: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
          requiredTools: [],
          requiredHooks: [],
          requiredCommands: [["visp\u0085"]],
        },
      }),
    ).toThrow(/control/i);
    expect(() =>
      runnerSpecSchema.parse({
        ...base,
        permissions: { mode: "read-only", requireSandbox: false },
        harness: {
          mode: "visp",
          files: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
          requiredTools: [],
          requiredHooks: [],
          requiredCommands: [command],
        },
      }),
    ).toThrow(/read-only|Bash/i);
  });
  it("normalizes Codex usage without billing cached or reasoning tokens twice", () => {
    const adapter = adapterFor("codex");
    expect(
      adapter.parse(
        {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 75,
            output_tokens: 20,
            reasoning_output_tokens: 8,
          },
        },
        "small",
      ),
    ).toMatchObject({
      type: "completed",
      usage: [
        {
          model: "small",
          inputTokens: 100,
          cachedInputTokens: 75,
          cacheWriteInputTokens: 0,
          outputTokens: 20,
          reasoningTokens: 8,
        },
      ],
    });
    expect(() =>
      adapter.parse(
        {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 2,
            output_tokens: 1,
          },
        },
        "small",
      ),
    ).toThrow(/cached/i);
  });

  it("uses per-model Claude totals instead of adding cumulative assistant usage", () => {
    const adapter = adapterFor("claude");
    expect(
      adapter.parse(
        {
          type: "assistant",
          message: {
            model: "small",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
        "small",
      ).usage,
    ).toBeUndefined();
    expect(
      adapter.parse(
        {
          type: "result",
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.04,
          modelUsage: {
            small: {
              inputTokens: 10,
              cacheReadInputTokens: 20,
              cacheCreationInputTokens: 5,
              outputTokens: 3,
            },
          },
        },
        "small",
      ),
    ).toMatchObject({
      type: "completed",
      estimatedUsd: 0.04,
      usage: [
        {
          model: "small",
          inputTokens: 35,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 5,
          outputTokens: 3,
          reasoningTokens: null,
        },
      ],
    });
  });

  it("does not silently call a malformed result or zero-exit error successful", () => {
    expect(
      adapterFor("claude").parse(
        { type: "result", subtype: "error_max_turns", is_error: true },
        "small",
      ).type,
    ).toBe("failed");
    expect(() => adapterFor("codex").parse({ type: "turn.completed" }, "small")).toThrow(/usage/i);
    expect(
      adapterFor("codex").parse(
        {
          type: "item.completed",
          item: {
            id: "call-1",
            type: "mcp_tool_call",
            server: "visp",
            tool: "next",
            status: "completed",
          },
        },
        "small",
      ).toolCalls,
    ).toEqual([{ id: "call-1", name: "visp.next", outcome: "completed" }]);
  });

  it("counts Claude tool uses instead of its initialization inventory", () => {
    const adapter = adapterFor("claude");
    expect(
      adapter.parse(
        { type: "system", subtype: "init", session_id: "session", tools: ["mcp__visp__visp_next"] },
        "small",
      ).observedTools,
    ).toBeUndefined();
    expect(
      adapter.parse(
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "mcp__visp__visp_next", id: "tool-1" }],
          },
        },
        "small",
      ).toolCalls,
    ).toEqual([{ id: "tool-1", name: "mcp__visp__visp_next", outcome: "started" }]);
    expect(
      adapter.parse(
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: false }],
          },
        },
        "small",
      ).toolCalls,
    ).toEqual([{ id: "tool-1", outcome: "completed" }]);
    expect(
      adapter.parse(
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-2", is_error: true }],
          },
        },
        "small",
      ).toolCalls,
    ).toEqual([{ id: "tool-2", outcome: "failed" }]);
  });

  it("normalizes Claude Bash command lifecycle observations", () => {
    const adapter = adapterFor("claude");
    expect(
      adapter.parse(
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                id: "command-1",
                input: { command: "visp next --json" },
              },
            ],
          },
        },
        "small",
      ).commandCalls,
    ).toEqual([{ id: "command-1", argv: ["visp", "next", "--json"], outcome: "started" }]);
    expect(
      adapter.parse(
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "command-1", is_error: false }],
          },
        },
        "small",
      ).commandCalls,
    ).toEqual([{ id: "command-1", outcome: "completed" }]);
  });

  it.each([
    "visp\tnext --json",
    "visp\rnext --json",
    "visp\nnext --json",
    "visp\u0000next --json",
    "visp\u0085next --json",
    "visp\u00a0next --json",
    "visp\u2028next --json",
  ])("rejects raw command controls: %j", (command) => {
    expect(parseObservedCommand(command)).toBeUndefined();
  });

  it.each(["visp next --json#comment", "visp next '--json#comment'"])(
    "rejects shell comments in observed commands, including quoted markers: %s",
    (command) => {
      expect(parseObservedCommand(command)).toBeUndefined();
    },
  );

  it("rejects oversized raw commands and arguments before crediting them", () => {
    expect(parseObservedCommand("a".repeat(65_537))).toBeUndefined();
    expect(parseObservedCommand(`visp ${"a".repeat(4_097)}`)).toBeUndefined();
    expect(
      parseObservedCommand(`/bin/bash -lc '${" ".repeat(4_100)}visp next --json'`),
    ).toBeUndefined();
  });

  it("normalizes successful and failed Codex command executions", () => {
    const adapter = adapterFor("codex");
    expect(
      adapter.parse(
        {
          type: "item.started",
          item: {
            id: "command-1",
            type: "command_execution",
            command: "visp next --json",
            status: "in_progress",
          },
        },
        "small",
      ).commandCalls,
    ).toEqual([{ id: "command-1", argv: ["visp", "next", "--json"], outcome: "started" }]);
    expect(
      adapter.parse(
        {
          type: "item.completed",
          item: {
            id: "command-1",
            type: "command_execution",
            command: "visp next --json",
            status: "completed",
            exit_code: 0,
          },
        },
        "small",
      ).commandCalls,
    ).toEqual([{ id: "command-1", argv: ["visp", "next", "--json"], outcome: "completed" }]);
    expect(
      adapter.parse(
        {
          type: "item.completed",
          item: {
            id: "command-2",
            type: "command_execution",
            command: "visp next --json",
            status: "completed",
            exit_code: 1,
          },
        },
        "small",
      ).commandCalls,
    ).toEqual([{ id: "command-2", argv: ["visp", "next", "--json"], outcome: "failed" }]);
  });

  it("passes bounded Claude tool permissions for each runner mode", () => {
    const spec = {
      host: { kind: "claude", model: "small" },
      permissions: { mode: "workspace-write" },
      budget: { maxEstimatedUsd: 1 },
      harness: { requiredTools: ["mcp__visp__visp_next"] },
    };
    expect(adapterFor("claude").arguments(spec as never)).not.toContain("--allowedTools");
    expect(
      adapterFor("claude")
        .arguments({
          ...spec,
          permissions: {
            mode: "workspace-write",
            requireSandbox: false,
            allowedTools: ["Read", "mcp__visp__visp_next"],
          },
        } as never)
        .slice(-2),
    ).toEqual(["--allowedTools", "Read,mcp__visp__visp_next"]);
  });

  it("rejects an inclusive token total that overflows safe provider counters", () => {
    expect(() =>
      adapterFor("claude").parse(
        {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: {
            input_tokens: Number.MAX_SAFE_INTEGER,
            cache_read_input_tokens: 1,
            output_tokens: 0,
          },
        },
        "small",
      ),
    ).toThrow(/safe integer/i);
  });

  it("discloses unavailable strict monetary and universal sandbox enforcement", () => {
    expect(adapterFor("codex").capabilities).toMatchObject({
      monetaryEnforcement: "estimated",
      sandbox: "host-requested",
      instructionLoading: "unobservable",
    });
    expect(adapterFor("claude").capabilities).toMatchObject({
      monetaryEnforcement: "host-estimated",
      sandbox: "unavailable",
    });
  });
});
