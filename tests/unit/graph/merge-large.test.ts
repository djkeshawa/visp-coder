import { expect, it } from "vitest";
import { appendAll } from "../../../src/graph/append.js";
import type { ExtractionOutcome } from "../../../src/graph/extract/index.js";
import { mergeFacts } from "../../../src/graph/merge.js";
import type { GraphSnapshot, Relation } from "../../../src/graph/types.js";

it("appends arrays far larger than a call's argument limit", () => {
  const target: number[] = [];
  appendAll(target, new Array(500_000).fill(1));
  expect(target).toHaveLength(500_000);
});

// A Django-size index carries ~135,000 relations; spreading them into push overflowed the stack.
it("merges a previous snapshot with hundreds of thousands of reusable relations", () => {
  const file = { id: "file:a.py", kind: "file", path: "a.py", name: "a.py" };
  const relations: Relation[] = Array.from({ length: 300_000 }, (_, index) => ({
    source: "file:a.py",
    target: `external:mod${index}`,
    kind: "imports",
    path: "a.py",
    line: 1,
  })) as Relation[];
  const previous = {
    entities: [file],
    relations,
    unknowns: [],
    entrypoints: [],
  } as unknown as GraphSnapshot;
  const fresh = {
    entities: [],
    relations: [],
    unknowns: [],
    entrypoints: [],
    parsedPaths: [],
  } as unknown as ExtractionOutcome;
  const merged = mergeFacts(fresh, previous, new Set(["a.py"]), new Set(["a.py"]));
  expect(merged.relations.length).toBe(300_000);
});
