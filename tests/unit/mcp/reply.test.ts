import { describe, expect, it } from "vitest";
import { vispError } from "../../../src/core/errors.js";
import { err, ok } from "../../../src/core/result.js";
import { failure, reply } from "../../../src/mcp/reply.js";

function text(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as { type: string; text?: string }[];
  return blocks.map((block) => block.text ?? "").join("\n");
}

describe("reply", () => {
  it("returns both prose and structured content on success", () => {
    const result = reply("visp_status", ok({ feature: "001-login" }), {
      text: (value) => `Feature: ${value.feature}`,
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe("Feature: 001-login");
    expect(result.structuredContent).toEqual({
      tool: "visp_status",
      ok: true,
      data: { feature: "001-login" },
    });
  });

  it("carries the next command in both the prose and the structured content", () => {
    const result = reply("visp_next", ok({ command: "visp spec" }), {
      text: () => "No active feature.",
      nextCommand: (value) => value.command,
    });

    expect(text(result)).toContain("Next: visp spec");
    expect(result.structuredContent).toMatchObject({ nextCommand: "visp spec" });
  });

  it("maps a Result error to isError with the message and recovery", () => {
    const result = reply(
      "visp_spec",
      err(
        vispError("NO_ACTIVE_FEATURE", "No feature is active", {
          recovery: 'visp feature "<goal>"',
        }),
      ),
      { text: () => "unreachable" },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("No feature is active");
    expect(text(result)).toContain('Try: visp feature "<goal>"');
    expect(result.structuredContent).toEqual({
      tool: "visp_spec",
      ok: false,
      error: {
        code: "NO_ACTIVE_FEATURE",
        message: "No feature is active",
        recovery: 'visp feature "<goal>"',
      },
    });
  });

  it("omits recovery when the error has none, and keeps details", () => {
    const result = failure(
      "visp_guard",
      vispError("IO_ERROR", "Disk is gone", { details: { path: "/tmp/x" } }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Disk is gone\nDetails: {"path":"/tmp/x"}');
    expect(text(result)).not.toContain("Try:");
    expect(result.structuredContent).toEqual({
      tool: "visp_guard",
      ok: false,
      error: { code: "IO_ERROR", message: "Disk is gone", details: { path: "/tmp/x" } },
    });
  });
});
