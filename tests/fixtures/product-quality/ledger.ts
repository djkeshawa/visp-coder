/** Independent non-UI evaluation fixture: cancelling pending work must preserve committed progress. */
export function createLedger(resetCommittedOnCancel = false) {
  let committed = 0;
  let pending = 0;
  return {
    begin(amount: number) {
      pending = amount;
    },
    commit() {
      committed += pending;
      pending = 0;
    },
    cancel() {
      pending = 0;
      if (resetCommittedOnCancel) committed = 0;
    },
    snapshot() {
      return { committed, pending };
    },
  };
}
