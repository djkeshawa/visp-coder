import { expect, it } from "vitest";
import { assertBehaviorSensitive, assertTransitions } from "../../../src/testing/transitions.js";
import { createLedger } from "../../fixtures/product-quality/ledger.js";

it("detects cancellation erasing earlier committed work with a shared non-UI verifier", async () => {
  await assertBehaviorSensitive({
    label: "preserve committed progress",
    baseline: () => createLedger(),
    changed: () => createLedger(true),
    verify: (ledger) => {
      ledger.begin(7);
      ledger.commit();
      ledger.begin(3);
      ledger.cancel();
      const afterCancel = ledger.snapshot();
      ledger.begin(2);
      ledger.commit();
      return (
        afterCancel.committed === 7 &&
        afterCancel.pending === 0 &&
        ledger.snapshot().committed === 9
      );
    },
  });
  const ledger = createLedger();
  ledger.begin(7);
  ledger.commit();
  await expect(
    assertTransitions({
      label: "retry after cancel",
      sample: () => ledger.snapshot(),
      steps: [
        {
          name: "cancel",
          act: () => {
            ledger.begin(3);
            ledger.cancel();
          },
          verify: (before, after) => after.pending === 0 && after.committed === before.committed,
        },
        {
          name: "retry",
          act: () => {
            ledger.begin(2);
            ledger.commit();
          },
          verify: (before, after) => after.committed === before.committed + 2,
        },
      ],
    }),
  ).resolves.toHaveLength(2);
});
