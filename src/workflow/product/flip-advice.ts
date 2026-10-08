import { latestExecutionsByOwner } from "./model.js";
import type { ProductNext } from "./status.js";
import type { ProductRecord } from "./store.js";

/** Advice never changes the action, gates, or evidence credit. */
export function withFlipAdvice(record: ProductRecord, next: ProductNext): ProductNext {
  const advice = latestExecutionsByOwner(record.state.executions)
    .filter(
      (entry) =>
        entry.flip?.failsWithoutChange === false && (!next.task || entry.task === next.task),
    )
    .map(
      (entry) =>
        `${entry.check} also passes with your source change reverted, so it does not show the requested change. Add a test that fails on the old code and passes now (keep it), then rerun visp done.`,
    );
  return advice.length
    ? {
        ...next,
        evidence: [...advice.filter((line) => !next.evidence.includes(line)), ...next.evidence],
      }
    : next;
}
