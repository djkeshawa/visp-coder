import { MINIMAL_TOOLS, TOOL, type ToolName } from "./constants.js";

export interface McpAction {
  readonly tool: ToolName;
  readonly arguments: Record<string, string | boolean>;
}

const commandTools: Record<string, ToolName> = {
  next: TOOL.next,
  status: TOOL.status,
  feature: TOOL.feature,
  brief: TOOL.brief,
  work: TOOL.work,
  done: TOOL.done,
  verify: TOOL.verify,
  accept: TOOL.accept,
  review: TOOL.review,
  critic: TOOL.critic,
  capture: TOOL.capture,
  reproduce: TOOL.reproduce,
  query: TOOL.query,
  index: TOOL.index,
};

/** CLI commands are an engine-level hint; MCP presents a callable tool and arguments. */
export function mcpAction(command: string): McpAction | undefined {
  const match = /^visp\s+(\w+)\b/.exec(command);
  if (!match) return undefined;
  const tool = commandTools[match[1] ?? ""];
  if (!tool) return undefined;
  const arguments_ = actionArguments(tool, command, parseOptions(command));
  // The minimal profile has no status, index or verify tool. Re-query next rather than
  // sending a worker to an unavailable tool or an unrelated executable on PATH.
  if (!MINIMAL_TOOLS.has(tool))
    return {
      tool: TOOL.next,
      arguments: typeof arguments_.feature === "string" ? { feature: arguments_.feature } : {},
    };
  return { tool, arguments: arguments_ };
}

function parseOptions(command: string): Record<string, string | boolean> {
  const arguments_: Record<string, string | boolean> = {};
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let index = 2; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("--")) continue;
    const [option, inline] = token.slice(2).split("=", 2);
    const key = (option ?? "").replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (!key) continue;
    const next = tokens[index + 1];
    const raw = inline ?? (next && (!next.startsWith("--") || next === "-") ? next : undefined);
    arguments_[key] = raw === undefined ? true : raw.replace(/^['"]|['"]$/g, "");
    if (inline === undefined && raw !== undefined) index++;
  }
  return arguments_;
}

function actionArguments(
  tool: ToolName,
  command: string,
  arguments_: Record<string, string | boolean>,
): Record<string, string | boolean> {
  if (tool === TOOL.feature) {
    const goal = /^visp feature\s+("[^"]*"|'[^']*'|[^\s-]+)/.exec(command)?.[1];
    if (goal) arguments_.goal = goal.replace(/^['"]|['"]$/g, "");
  }
  if (tool === TOOL.critic) {
    arguments_.operation =
      arguments_.preflight === true
        ? "preflight"
        : arguments_.prepare === true
          ? "prepare"
          : arguments_.dispatch === true
            ? "review"
            : "status";
    delete arguments_.preflight;
    delete arguments_.prepare;
    delete arguments_.dispatch;
    delete arguments_.capabilities;
  }
  if (tool === TOOL.review) delete arguments_.from;
  if (tool === TOOL.feature) delete arguments_.sourceBrief;
  return arguments_;
}

export function mcpActionText(command: string): string | undefined {
  const action = mcpAction(command);
  return action ? `${action.tool} ${JSON.stringify(action.arguments)}` : undefined;
}
