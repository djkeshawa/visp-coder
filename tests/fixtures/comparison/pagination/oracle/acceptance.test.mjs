import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.CANDIDATE_ROOT) throw new Error("CANDIDATE_ROOT must name the isolated candidate");
const { paginate } = await import(pathToFileURL(join(process.env.CANDIDATE_ROOT, "src/paginate.mjs")));

test("full and partial pages retain every boundary item without mutation", () => {
  const values = Object.freeze(["a", "b", "c", "d", "e"]);
  assert.deepEqual(paginate(values, 1, 2), ["a", "b"]);
  assert.deepEqual(paginate(values, 2, 2), ["c", "d"]);
  assert.deepEqual(paginate(values, 3, 2), ["e"]);
  assert.deepEqual(paginate(values, 4, 2), []);
  assert.deepEqual(paginate([], 1, 10), []);
  assert.deepEqual(paginate(values, 1, 1), ["a"]);
});
test("invalid page coordinates are rejected", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, "2", null]) {
    assert.throws(() => paginate([1, 2], value, 2));
    assert.throws(() => paginate([1, 2], 1, value));
  }
});
