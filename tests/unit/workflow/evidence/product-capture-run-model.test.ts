import { describe, expect, it } from "vitest";
import {
  captureRunEntries,
  validCaptureRuns,
} from "../../../../src/workflow/product/capture-run-model.js";

const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  version: 1,
  provenance: "runner-executed",
  subjectDigest: "subject",
  captures: [],
  operations: [],
  ...extra,
});

const record = (captureRuns: unknown[]) => ({ state: { captureRuns } });

describe("capture runs of a record", () => {
  it("returns the runs that parse, in order, and skips damaged or foreign ones", () => {
    const runs = validCaptureRuns(
      record([run("a"), null, "text", { id: "b" }, run("c", { provenance: "agent" }), run("d")]),
    );
    expect(runs.map((entry) => entry.id)).toEqual(["a", "d"]);
  });

  it("returns an empty list for a record without runs", () => {
    expect(validCaptureRuns(record([]))).toEqual([]);
  });

  it("keeps the stored value, with fields the schema does not know, beside the parsed run", () => {
    const stored = run("a", { legacyField: "kept" });
    const [entry] = captureRunEntries(record([{ id: "x" }, stored]));
    expect(entry?.stored).toBe(stored);
    expect(entry?.run.id).toBe("a");
    expect(entry?.run).not.toHaveProperty("legacyField");
  });
});
