import { describe, expect, it } from "vitest";
import { type AnswerStyle, renderQueryAnswer } from "../../../../src/graph/query/render.js";
import type { QueryEnvelope, QueryOperation } from "../../../../src/graph/query/types.js";
import type { UnknownRecord } from "../../../../src/graph/types.js";

const STYLE: AnswerStyle = {
  indent: "> ",
  summaryLine: (key, value) => `${key}=${String(value)}`,
  truncationHint: () => "hint",
};

const UNRESOLVED: UnknownRecord = {
  kind: "unresolved_import",
  path: "src/legacy.ts",
  detail: "./missing.js",
};

function answer(
  operation: QueryOperation,
  parts: Partial<Pick<QueryEnvelope, "rows" | "unknowns" | "notes">> = {},
): QueryEnvelope {
  return {
    operation,
    rows: parts.rows ?? [],
    unknowns: parts.unknowns ?? [],
    notes: parts.notes ?? [],
    receipt: {
      snapshotId: "s",
      createdAt: "2026-10-05T00:00:00.000Z",
      operation,
      budget: { depth: 1, results: 10 },
      truncated: false,
      resultHash: "h",
    },
  };
}

describe("renderQueryAnswer", () => {
  it("lists unknowns with their detail as the answer to an unknowns query", () => {
    const text = renderQueryAnswer(answer("unknowns", { unknowns: [UNRESOLVED] }), STYLE);

    expect(text).toBe(`> ${"unresolved_import".padEnd(24)} src/legacy.ts  ./missing.js`);
  });

  it("says there are no results when an unknowns query finds no gaps", () => {
    expect(renderQueryAnswer(answer("unknowns"), STYLE)).toBe("> no results");
  });

  it("keeps an empty answer distinguishable from a gap for other operations", () => {
    const text = renderQueryAnswer(answer("search", { unknowns: [UNRESOLVED] }), STYLE);

    expect(text).toBe(
      ["> no results", "", "Not determined:", "  unresolved_import at src/legacy.ts"].join("\n"),
    );
  });

  it("puts rows before the gaps that accompany them", () => {
    const text = renderQueryAnswer(
      answer("callers", {
        rows: [
          {
            kind: "entity",
            key: "k",
            path: "src/login.ts",
            name: "login",
            detail: "",
            startLine: 2,
          },
        ],
        unknowns: [UNRESOLVED],
        notes: ["a note"],
      }),
      STYLE,
    );

    expect(text).toBe(
      [
        "> src/login.ts:2  login",
        "",
        "Not determined:",
        "  unresolved_import at src/legacy.ts",
        "",
        "a note",
      ].join("\n"),
    );
  });
});
