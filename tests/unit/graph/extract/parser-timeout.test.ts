import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSource } from "../../../../src/graph/extract/parser.js";

afterEach(() => vi.restoreAllMocks());

describe("parser cancellation", () => {
  it("resets the cached parser after a timed-out input", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(3000);
    const cancelled = await parseSource("javascript", "const value = 1;\n".repeat(50_000));
    if (cancelled.kind === "parsed") cancelled.dispose();
    expect(cancelled.kind).toBe("timeout");
    now.mockRestore();

    const next = await parseSource("javascript", "const small = 1;\n");
    expect(next.kind).toBe("parsed");
    if (next.kind === "parsed") {
      expect(next.tree.root.namedChildren).toHaveLength(1);
      next.dispose();
    }
  });
});
