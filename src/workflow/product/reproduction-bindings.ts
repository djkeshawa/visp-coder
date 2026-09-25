import { hashValue } from "../../core/hash.js";
import { reproductionSchema } from "./reproduction-model.js";
import type { ProductRecord } from "./store.js";

/** Historical links preserve the report's subject; they do not claim it was executed. */
export function findingReproductions(
  record: ProductRecord,
  finding: {
    readonly id?: string;
    readonly legacyId?: string;
    readonly subjectDigest: string;
    readonly task?: string;
  },
) {
  if (!finding.id) return [];
  return (record.state.reproductions ?? []).flatMap((input) => {
    const parsed = reproductionSchema.safeParse(input);
    if (!parsed.success) return [];
    const link = parsed.data;
    if (
      (link.finding !== finding.id && link.finding !== finding.legacyId) ||
      link.findingSubject !== finding.subjectDigest
    )
      return [];
    const matches = record.state.executions.filter((entry) => entry.id === link.execution);
    const receipt = matches[0];
    if (
      matches.length !== 1 ||
      !receipt ||
      receipt.task !== finding.task ||
      hashValue(receipt) !== link.executionDigest ||
      receipt.provenance !== "supervisor-executed" ||
      receipt.status !== "failed" ||
      receipt.exitCode === 0
    )
      return [];
    return [
      {
        ...link,
        subjectDigest: receipt.subjectDigest,
        task: receipt.task,
        check: receipt.check,
        command: receipt.command,
        output: receipt.output.slice(-2000),
        outputTruncated: receipt.output.length > 2000,
        comparisonEnvironment: receipt.comparisonEnvironment,
        guidance:
          "Historical executed failure. Caller-reported relevance must be assessed against the original finding; this does not prove that the original subject failed.",
      },
    ];
  });
}

/** Packet freshness includes attachment claims, even when product source is unchanged. */
export function reproductionContextDigest(record: ProductRecord) {
  return record.state.reproductions?.length
    ? hashValue({ version: 1, reproductions: record.state.reproductions })
    : undefined;
}
