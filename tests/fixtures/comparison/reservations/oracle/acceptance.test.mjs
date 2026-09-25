import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.CANDIDATE_ROOT) throw new Error("CANDIDATE_ROOT must name the isolated candidate");
const { createLedger } = await import(pathToFileURL(join(process.env.CANDIDATE_ROOT, "src/reservations.mjs")));

test("reservations remain consistent across retry, rejection, release and reuse", () => {
  const ledger = createLedger(5);
  assert.equal(ledger.reserve("alpha", 3), true);
  assert.equal(ledger.reserve("alpha", 3), true);
  assert.equal(ledger.reserve("beta", 3), false);
  assert.throws(() => ledger.reserve("alpha", 1));
  assert.equal(ledger.reserve("beta", 2), true);
  assert.equal(ledger.release("missing"), false);
  assert.equal(ledger.release("alpha"), true);
  assert.equal(ledger.release("alpha"), false);
  assert.equal(ledger.reserve("gamma", 3), true);
  assert.deepEqual(ledger.snapshot(), { capacity: 5, available: 0, reservations: [{ id: "beta", count: 2 }, { id: "gamma", count: 3 }] });
});
test("snapshots cannot alter later reservations", () => {
  const ledger = createLedger(2);
  ledger.reserve("one", 1);
  const snapshot = ledger.snapshot();
  try { snapshot.reservations[0].count = 99; snapshot.reservations.push({ id: "forged", count: 99 }); } catch {}
  assert.equal(ledger.reserve("two", 1), true);
  assert.equal(ledger.snapshot().available, 0);
});
test("invalid inputs do not mutate the ledger", () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity, "5"]) assert.throws(() => createLedger(capacity));
  const ledger = createLedger(5);
  for (const count of [0, -1, 1.5, NaN, Infinity, "2"]) assert.throws(() => ledger.reserve("id", count));
  assert.throws(() => ledger.reserve("", 1));
  assert.equal(ledger.snapshot().available, 5);
});
