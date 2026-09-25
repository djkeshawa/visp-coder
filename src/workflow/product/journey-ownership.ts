import { productJourneyKey } from "../evidence/product-journey.js";
import { isBrowserCheckCommand } from "./check-command.js";
import type { ProductRecord } from "./store.js";

/** A declared verifier cannot be bypassed by resolving its captured journey as an experiment. */
export function isDeclaredJourney(
  record: ProductRecord,
  run: { id?: string; task?: string; journeyKey?: string },
) {
  return (
    record.state.executions.some(
      (entry) => entry.captureRunId !== undefined && entry.captureRunId === run.id,
    ) || isCurrentDeclaredJourney(record, run)
  );
}

/** Historical ownership survives a method revision; it is not the current assertion. */
export function isCurrentDeclaredJourney(
  record: ProductRecord,
  run: { task?: string; journeyKey?: string },
) {
  return record.brief.checks.some(
    (check) =>
      isBrowserCheckCommand(check.command) &&
      productJourneyKey(check.command.journey, run.task) === run.journeyKey,
  );
}

/** A revised declared assertion needs execution of that same check, not an ad hoc bypass. */
export function hasExecutedDeclaredRevision(
  record: ProductRecord,
  failure: { id?: string; task?: string; journeyKey?: string },
  replacement: { id?: string; task?: string; journeyKey?: string },
) {
  if (isCurrentDeclaredJourney(record, failure)) return false;
  const owners = record.state.executions.filter(
    (entry) => entry.captureRunId !== undefined && entry.captureRunId === failure.id,
  );
  return (
    owners.length > 0 &&
    owners.every((owner) => {
      const check = record.brief.checks.find((entry) => entry.id === owner.check);
      return (
        check &&
        isBrowserCheckCommand(check.command) &&
        productJourneyKey(check.command.journey, replacement.task) === replacement.journeyKey &&
        record.state.executions.some(
          (entry) =>
            entry.check === owner.check &&
            entry.task === owner.task &&
            entry.status === "passed" &&
            entry.captureRunId !== undefined &&
            entry.captureRunId === replacement.id,
        )
      );
    })
  );
}
