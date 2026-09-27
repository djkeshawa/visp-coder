import { expect, it } from "vitest";
import { selectedNotes } from "../../../../src/workflow/product/memory-gate.js";

// The model names notes by number; only real numbers count, and notes keep their order.
it("keeps only the notes the model named, ignoring numbers it made up", () => {
  expect(selectedNotes(["a", "b", "c"], [3, 1, 7, 0, 1])).toEqual(["a", "c"]);
});
