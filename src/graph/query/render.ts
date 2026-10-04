import type { UnknownRecord } from "../types.js";
import type { QueryEnvelope } from "./types.js";

/** What differs between the CLI and MCP renderings of the same answer. */
export interface AnswerStyle {
  /** Prefix for each row of the answer. */
  readonly indent: string;
  readonly summaryLine: (key: string, value: unknown) => string;
  readonly truncationHint: (answer: QueryEnvelope) => string;
}

/**
 * One layout for both surfaces, so a fix to how an answer reads cannot land
 * on one surface and be missed on the other.
 */
export function renderQueryAnswer(answer: QueryEnvelope, style: AnswerStyle): string {
  const lines = Object.entries(answer.summary ?? {}).map(([key, value]) =>
    style.summaryLine(key, value),
  );

  for (const row of answer.rows) {
    const where = row.startLine === undefined ? row.path : `${row.path}:${row.startLine}`;
    lines.push(`${style.indent}${where}  ${row.name}${row.detail ? `  ${row.detail}` : ""}`);
  }

  // For `unknowns` the unknowns *are* the answer, so listing them under a
  // "not determined" aside — after saying there were no results — contradicts
  // itself. Everywhere else they are context alongside the rows.
  const unknownsAreTheAnswer = answer.operation === "unknowns";
  if (unknownsAreTheAnswer) {
    lines.push(...answer.unknowns.map((unknown) => style.indent + describeUnknown(unknown)));
  }

  if (lines.length === 0) lines.push(`${style.indent}no results`);

  // Unknowns survive truncation, so an agent can tell a gap from an absence.
  if (!unknownsAreTheAnswer && answer.unknowns.length > 0) {
    lines.push(
      "",
      "Not determined:",
      ...answer.unknowns.map((unknown) => `  ${unknown.kind} at ${unknown.path}`),
    );
  }

  for (const note of answer.notes) lines.push("", note);
  if (answer.receipt.truncated) lines.push("", style.truncationHint(answer));

  return lines.join("\n");
}

function describeUnknown(unknown: UnknownRecord): string {
  return `${unknown.kind.padEnd(24)} ${unknown.path}${unknown.detail ? `  ${unknown.detail}` : ""}`;
}
