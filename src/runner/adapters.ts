import { amount, count, object, optionalObject, requiredText } from "../core/validation-values.js";

export { amount, count, object, optionalObject, requiredText } from "../core/validation-values.js";

import { parseObservedCommand } from "./command-observation.js";
import type {
  AdapterCapabilities,
  HostEvent,
  NormalizedUsage,
  RunnerHost,
  RunnerSpec,
} from "./contracts.js";

export interface HostAdapter {
  readonly capabilities: AdapterCapabilities;
  arguments(spec: RunnerSpec, sessionId?: string): string[];
  parse(row: Record<string, unknown>, model: string): HostEvent;
}

export function adapterFor(host: RunnerHost): HostAdapter {
  return host === "codex" ? codex : claude;
}

const codex: HostAdapter = {
  capabilities: {
    monetaryEnforcement: "estimated",
    sandbox: "host-requested",
    instructionLoading: "unobservable",
    hookEvents: false,
    resume: true,
  },
  arguments(spec, sessionId) {
    const args = [
      "exec",
      ...(sessionId ? ["resume", sessionId] : []),
      "--json",
      "--model",
      spec.host.model,
    ];
    // Resume inherits sandbox/configuration from the explicitly named session.
    if (!sessionId)
      args.push(
        "--sandbox",
        spec.permissions.mode,
        "--ignore-user-config",
        "--config",
        'approval_policy="never"',
      );
    if (spec.host.effort)
      args.push("--config", `model_reasoning_effort=${JSON.stringify(spec.host.effort)}`);
    return [...args, "-"];
  },
  parse(row, model) {
    if (row.type === "thread.started")
      return { type: "started", sessionId: requiredText(row.thread_id, "thread_id") };
    if (row.type === "turn.failed" || row.type === "error") return { type: "failed" };
    if (row.type === "turn.completed") {
      const u = object(row.usage, "usage");
      return {
        type: "completed",
        usage: [
          validateUsage({
            model,
            inputTokens: count(u.input_tokens, "input_tokens"),
            cachedInputTokens: count(u.cached_input_tokens ?? 0, "cached_input_tokens"),
            cacheWriteInputTokens: 0,
            outputTokens: count(u.output_tokens, "output_tokens"),
            reasoningTokens:
              u.reasoning_output_tokens === undefined
                ? null
                : count(u.reasoning_output_tokens, "reasoning_output_tokens"),
          }),
        ],
      };
    }
    const item = optionalObject(row.item);
    return codexCommandEvent(row, item) ?? codexToolEvent(row, item) ?? { type: "progress" };
  },
};

const claude: HostAdapter = {
  capabilities: {
    monetaryEnforcement: "host-estimated",
    sandbox: "unavailable",
    instructionLoading: "unobservable",
    hookEvents: true,
    resume: true,
  },
  arguments(spec, sessionId) {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-hook-events",
      "--model",
      spec.host.model,
      "--max-budget-usd",
      String(spec.budget.maxEstimatedUsd),
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "project",
    ];
    if (spec.permissions.mode === "read-only") args.push("--tools", "Read,Glob,Grep");
    if (spec.permissions.allowedTools)
      args.push("--allowedTools", spec.permissions.allowedTools.join(","));
    if (spec.host.effort) args.push("--effort", spec.host.effort);
    if (sessionId) args.push("--resume", sessionId);
    return args;
  },
  parse(row, model) {
    if (row.type === "system" && row.subtype === "init") {
      return {
        type: "started",
        sessionId: requiredText(row.session_id, "session_id"),
        reportedModel: typeof row.model === "string" ? row.model : undefined,
      };
    }
    if (row.type === "system" && row.subtype === "hook_response" && row.exit_code === 0) {
      return { type: "progress", observedHooks: [requiredText(row.hook_name, "hook_name")] };
    }
    const message = claudeMessageEvent(row);
    if (message) return message;
    if (row.type !== "result") return { type: "progress" };
    return {
      type: row.is_error === false && row.subtype === "success" ? "completed" : "failed",
      sessionId: typeof row.session_id === "string" ? row.session_id : undefined,
      usage: claudeUsage(row, model),
      estimatedUsd:
        row.total_cost_usd === undefined ? undefined : amount(row.total_cost_usd, "total_cost_usd"),
    };
  },
};

function codexToolOutcome(item: Record<string, unknown>): "completed" | "failed" {
  const result = optionalObject(item.result);
  return item.status === "completed" &&
    item.error == null &&
    item.isError !== true &&
    result?.isError !== true &&
    result?.is_error !== true
    ? "completed"
    : "failed";
}

function codexCommandEvent(
  row: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): HostEvent | undefined {
  if (
    item?.type !== "command_execution" ||
    (row.type !== "item.started" && row.type !== "item.completed")
  )
    return undefined;
  const id = toolIdentity(item.id, "item.id");
  const command = parseObservedCommand(item.command);
  const outcome = row.type === "item.started" ? "started" : codexCommandOutcome(item);
  return {
    type: "progress",
    commandCalls: [{ id, ...(command ? { argv: command } : {}), outcome }],
  };
}

function codexToolEvent(
  row: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): HostEvent | undefined {
  if (
    item?.type !== "mcp_tool_call" ||
    (row.type !== "item.started" && row.type !== "item.completed")
  )
    return undefined;
  const id = toolIdentity(item.id, "item.id");
  const name = toolIdentity(
    `${toolIdentity(item.server, "server")}.${toolIdentity(item.tool, "tool")}`,
    "tool name",
  );
  const outcome = row.type === "item.started" ? "started" : codexToolOutcome(item);
  return { type: "progress", toolCalls: [{ id, name, outcome }] };
}

function codexCommandOutcome(item: Record<string, unknown>): "completed" | "failed" {
  return item.status === "completed" &&
    item.exit_code === 0 &&
    item.error == null &&
    item.isError !== true &&
    item.is_error !== true
    ? "completed"
    : "failed";
}

function claudeToolCalls(row: Record<string, unknown>): NonNullable<HostEvent["toolCalls"]> {
  const content = optionalObject(row.message)?.content;
  if (!Array.isArray(content)) return [];
  const calls: NonNullable<HostEvent["toolCalls"]>[number][] = [];
  for (const block of content) {
    const call = claudeToolCall(row.type, optionalObject(block));
    if (call) calls.push(call);
    if (calls.length > 256) throw new Error("Host message exceeded 256 tool lifecycle events");
  }
  return calls;
}

function claudeCommandCalls(row: Record<string, unknown>): NonNullable<HostEvent["commandCalls"]> {
  const content = optionalObject(row.message)?.content;
  if (!Array.isArray(content)) return [];
  const calls: NonNullable<HostEvent["commandCalls"]>[number][] = [];
  for (const block of content) {
    const call = claudeCommandCall(row.type, optionalObject(block));
    if (call) calls.push(call);
    if (calls.length > 256) throw new Error("Host message exceeded 256 command lifecycle events");
  }
  return calls;
}

function claudeCommandCall(
  role: unknown,
  value: Record<string, unknown> | undefined,
): NonNullable<HostEvent["commandCalls"]>[number] | undefined {
  if (role === "assistant" && value?.type === "tool_use" && value.name === "Bash") {
    const id = toolIdentity(value.id, "tool_use.id");
    const input = optionalObject(value.input);
    const command = parseObservedCommand(input?.command);
    return { id, ...(command ? { argv: command } : {}), outcome: "started" };
  }
  if (role !== "user" || value?.type !== "tool_result") return undefined;
  const id = toolIdentity(value.tool_use_id, "tool_result.tool_use_id");
  if (value.is_error !== undefined && typeof value.is_error !== "boolean")
    throw new Error("tool_result.is_error must be a boolean when present");
  return { id, outcome: value.is_error === true ? "failed" : "completed" };
}

function claudeMessageEvent(row: Record<string, unknown>): HostEvent | undefined {
  if (row.type !== "assistant" && row.type !== "user") return undefined;
  const calls = claudeToolCalls(row);
  const commandCalls = claudeCommandCalls(row);
  return {
    type: "progress",
    ...(calls.length ? { toolCalls: calls } : {}),
    ...(commandCalls.length ? { commandCalls } : {}),
  };
}

function claudeToolCall(
  role: unknown,
  value: Record<string, unknown> | undefined,
): NonNullable<HostEvent["toolCalls"]>[number] | undefined {
  if (role === "assistant" && value?.type === "tool_use")
    return {
      id: toolIdentity(value.id, "tool_use.id"),
      name: toolIdentity(value.name, "tool_use.name"),
      outcome: "started",
    };
  if (role !== "user" || value?.type !== "tool_result") return undefined;
  if (value.is_error !== undefined && typeof value.is_error !== "boolean")
    throw new Error("tool_result.is_error must be a boolean when present");
  return {
    id: toolIdentity(value.tool_use_id, "tool_result.tool_use_id"),
    outcome: value.is_error === true ? "failed" : "completed",
  };
}

function toolIdentity(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (text.length > 512 || /[\s\p{Cc}]/u.test(text))
    throw new Error(`${name} must be a bounded tool identity without whitespace or controls`);
  return text;
}

function claudeUsage(
  row: Record<string, unknown>,
  fallback: string,
): NormalizedUsage[] | undefined {
  const perModel = optionalObject(row.modelUsage);
  if (perModel)
    return Object.entries(perModel).map(([model, value]) => {
      const u = object(value, "modelUsage");
      const input = count(u.inputTokens, "inputTokens");
      const cached = count(u.cacheReadInputTokens ?? 0, "cacheReadInputTokens");
      const written = count(u.cacheCreationInputTokens ?? 0, "cacheCreationInputTokens");
      return validateUsage({
        model,
        inputTokens: input + cached + written,
        cachedInputTokens: cached,
        cacheWriteInputTokens: written,
        outputTokens: count(u.outputTokens, "outputTokens"),
        reasoningTokens: null,
      });
    });
  const u = optionalObject(row.usage);
  if (!u) return undefined;
  const input = count(u.input_tokens, "input_tokens");
  const cached = count(u.cache_read_input_tokens ?? 0, "cache_read_input_tokens");
  const written = count(u.cache_creation_input_tokens ?? 0, "cache_creation_input_tokens");
  return [
    validateUsage({
      model: fallback,
      inputTokens: input + cached + written,
      cachedInputTokens: cached,
      cacheWriteInputTokens: written,
      outputTokens: count(u.output_tokens, "output_tokens"),
      reasoningTokens: null,
    }),
  ];
}

export function validateUsage(value: NormalizedUsage): NormalizedUsage {
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
  ] as const)
    count(value[key], key);
  if (value.reasoningTokens !== null) count(value.reasoningTokens, "reasoningTokens");
  if (value.cachedInputTokens + value.cacheWriteInputTokens > value.inputTokens)
    throw new Error("Cached input exceeds total input");
  if (value.reasoningTokens !== null && value.reasoningTokens > value.outputTokens)
    throw new Error("Reasoning exceeds output tokens");
  return value;
}
