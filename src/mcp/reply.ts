import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { VispError } from "../core/errors.js";
import type { Result } from "../core/result.js";

/**
 * One output shape for every tool: prose for a reader and `structuredContent`
 * for a caller, so a weak model never has to parse the prose to act.
 */
export interface ToolEnvelope<T> {
  readonly tool: string;
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: VispError;
  readonly nextCommand?: string;
}

export interface ReplyOptions<T> {
  readonly text: (value: T) => string;
  readonly nextCommand?: (value: T) => string | undefined;
  /**
   * The structured view of the value, when the full object would repeat the
   * prose or carry weight the caller has no use for. Absent means verbatim.
   */
  readonly data?: (value: T) => unknown;
}

export function reply<T>(
  tool: string,
  result: Result<T>,
  options: ReplyOptions<T>,
): CallToolResult {
  if (!result.ok) return failure(tool, result.error);

  const nextCommand = options.nextCommand?.(result.value);
  const text = options.text(result.value);

  return {
    content: [{ type: "text", text: nextCommand ? `${text}\n\nNext: ${nextCommand}` : text }],
    structuredContent: {
      tool,
      ok: true,
      data: options.data ? options.data(result.value) : result.value,
      ...(nextCommand ? { nextCommand } : {}),
    },
  };
}

/**
 * A failed `Result` is a tool error: the call could not produce an answer. A
 * refusal (a gate saying no) is not — that is a successful answer of "no".
 */
export function failure(tool: string, error: VispError): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          error.message,
          error.details ? errorDetails(error.details) : undefined,
          error.recovery ? `Try: ${error.recovery}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    structuredContent: {
      tool,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.recovery ? { recovery: error.recovery } : {}),
        ...(error.details ? { details: error.details } : {}),
      },
    },
  };
}

function errorDetails(details: unknown): string {
  const text = JSON.stringify(details);
  return `Details: ${text.length <= 4000 ? text : `${text.slice(0, 4000)}… (full details in structuredContent.error.details)`}`;
}
