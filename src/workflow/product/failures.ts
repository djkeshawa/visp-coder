import { hashValue } from "../../core/hash.js";
import type { ProductExecution } from "./model.js";

/** Test durations, process IDs, and receipt IDs are not changes to the observed defect. */
export function productFailureSignature(
  execution: Pick<ProductExecution, "check" | "status" | "exitCode" | "output">,
): string {
  const output = execution.output
    .split("\n")
    .map((line) => line.replace(/^\s*ℹ\s*/, ""))
    .filter(
      (line) =>
        !/^\s*(?:#\s*)?(?:duration_ms|duration|time|start at|tests?\s+\d|suites?\s+\d|pass\s+\d|fail\s+\d|cancelled\s+\d|skipped\s+\d|todo\s+\d)\b/i.test(
          line,
        ),
    )
    .map((line) =>
      line
        .replace(/\(\d+(?:\.\d+)?\s*(?:ms|s)\)/g, "(<duration>)")
        .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<receipt>"),
    )
    .join("\n")
    .trim();
  return hashValue({
    check: execution.check,
    status: execution.status,
    exitCode: execution.exitCode,
    output,
  });
}
