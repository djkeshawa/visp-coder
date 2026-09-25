import { describe, expect, it } from "vitest";
import type { ContextPack } from "../../../../src/workflow/artifacts/context.js";
import { stableContextHash } from "../../../../src/workflow/stages/context/digest.js";
import {
  estimateFileTokens,
  estimateTokens,
  extractSnippets,
  FILE_OVERHEAD_TOKENS,
  snippetsAtRegions,
} from "../../support/legacy-context/snippets.js";

describe("stableContextHash", () => {
  const base: ContextPack = {
    kind: "context",
    createdAt: "2026-01-01T00:00:00.000Z",
    feature: "001-login",
    task: "T001",
    goal: "Add login",
    files: [
      {
        path: "src/auth/login.ts",
        reason: "expected-file",
        hash: "a".repeat(64),
        regions: [{ startLine: 1, endLine: 8, label: "login" }],
        snippets: [{ startLine: 1, endLine: 2, text: "export function login() {}" }],
        estimatedTokens: 40,
        truncated: false,
      },
    ],
    omitted: [],
    entrypoints: ["login"],
    unknowns: [],
    estimatedTokens: 80,
    tokenBudget: 4_000,
    graphAvailable: true,
  };

  function firstFile(): ContextPack["files"][number] {
    const file = base.files[0];
    if (!file) throw new Error("stable context fixture needs one file");
    return file;
  }

  it("ignores delivery and retry metadata", () => {
    const retryOnly: ContextPack = {
      ...base,
      createdAt: "2026-02-02T00:00:00.000Z",
      estimatedTokens: 999,
      tokenBudget: 8_000,
      files: [
        {
          ...firstFile(),
          snippets: [{ startLine: 7, endLine: 8, text: "different rendered excerpt" }],
          estimatedTokens: 300,
          truncated: true,
        },
      ],
      attemptFeedback: {
        source: "verification",
        capturedAt: "2026-02-02T00:00:00.000Z",
        attempt: 3,
        failingCommands: [],
        unresolvedFindings: [],
        referencedFiles: [],
      },
    };

    expect(stableContextHash(retryOnly, "graph-1")).toBe(stableContextHash(base, "graph-1"));
  });

  it("changes for source, selection, regions, unknowns, or graph identity", () => {
    const original = stableContextHash(base, "graph-1");
    const variants: ContextPack[] = [
      { ...base, goal: "Add secure login" },
      {
        ...base,
        files: [{ ...firstFile(), hash: "b".repeat(64) }],
      },
      {
        ...base,
        files: [
          {
            ...firstFile(),
            regions: [{ startLine: 2, endLine: 8, label: "login" }],
          },
        ],
      },
      { ...base, unknowns: ["runtime entrypoint"] },
    ];

    for (const variant of variants) {
      expect(stableContextHash(variant, "graph-1")).not.toBe(original);
    }
    expect(stableContextHash(base, "graph-2")).not.toBe(original);
  });
});

describe("extractSnippets", () => {
  const longFile = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");

  it("returns the whole file when the cap is off", () => {
    const { snippets, truncated } = extractSnippets(longFile, {
      cap: false,
      maxSnippets: 4,
      maxLines: 40,
    });
    expect(snippets).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  it("returns the whole file when it fits within the line budget", () => {
    const { truncated } = extractSnippets("one\ntwo", { cap: true, maxSnippets: 4, maxLines: 40 });
    expect(truncated).toBe(false);
  });

  it("truncates a long file and marks it truncated", () => {
    const { snippets, truncated } = extractSnippets(longFile, {
      cap: true,
      maxSnippets: 4,
      maxLines: 40,
    });
    expect(truncated).toBe(true);
    expect(snippets.length).toBeLessThanOrEqual(4);
    for (const snippet of snippets) {
      expect(snippet.endLine - snippet.startLine).toBeLessThan(40);
    }
  });

  it("includes regions around declarations beyond the file head", () => {
    const lines = Array.from({ length: 120 }, (_, index) =>
      index === 100 ? "export function deepFunction() {" : `line ${index}`,
    );
    const { snippets } = extractSnippets(lines.join("\n"), {
      cap: true,
      maxSnippets: 4,
      maxLines: 20,
    });
    expect(snippets.some((snippet) => snippet.text.includes("deepFunction"))).toBe(true);
  });
});

describe("snippetsAtRegions", () => {
  const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");

  it("slices the file at the given spans", () => {
    const { snippets, truncated } = snippetsAtRegions(text, [{ startLine: 10, endLine: 12 }]);

    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.text).toBe("line 10\nline 11\nline 12");
    expect(truncated).toBe(true);
  });

  it("clamps a span the file has grown shorter than", () => {
    const { snippets } = snippetsAtRegions(text, [{ startLine: 48, endLine: 90 }]);
    expect(snippets[0]?.endLine).toBe(50);
  });

  it("drops a span that starts past the end of the file", () => {
    const { snippets } = snippetsAtRegions(text, [{ startLine: 200, endLine: 210 }]);
    expect(snippets).toEqual([]);
  });

  it("is not truncated when the spans cover the whole file", () => {
    const { truncated } = snippetsAtRegions(text, [{ startLine: 1, endLine: 50 }]);
    expect(truncated).toBe(false);
  });
});

describe("estimateFileTokens", () => {
  it("charges the delivery framing on top of the snippet text", () => {
    const bare = estimateFileTokens({ snippets: [] });
    const withText = estimateFileTokens({ snippets: [{ text: "a".repeat(330) }] });

    expect(bare).toBe(FILE_OVERHEAD_TOKENS);
    expect(withText).toBe(FILE_OVERHEAD_TOKENS + estimateTokens("a".repeat(330)));
  });
});
