import type { ContextFile, ContextPack } from "../../../../src/workflow/artifacts/context.js";
import { estimateTokens } from "./snippets.js";

/**
 * The pack as a reading plan, for both delivery paths. The agent that can read
 * files gets paths, reasons and line ranges — not a copy of what is on disk —
 * and the failure it is answering, when there is one.
 */

/** More ranges than this reads as noise; the pack file still holds them all. */
const PRINTED_RANGES = 4;
export const PRINTED_OMISSIONS = 8;

export function describeRanges(file: ContextFile): string {
  if (file.regions.length === 0) return "";

  const shown = file.regions
    .slice(0, PRINTED_RANGES)
    .map((region) => `${region.startLine}-${region.endLine}`)
    .join(",");
  const more = file.regions.length > PRINTED_RANGES ? ",…" : "";
  return `:${shown}${more}`;
}

/** One line per file: `reason  path:12-48,90-140 (~350 tokens)`. */
export function renderReadingPlan(pack: ContextPack): string[] {
  const lines = pack.files.map(
    (file) =>
      `  ${file.reason.padEnd(22)} ${file.path}${describeRanges(file)}` +
      (file.estimatedTokens > 0 ? ` (~${file.estimatedTokens} tokens)` : ""),
  );

  const previewLimit = pack.omissionPreviewLimit ?? PRINTED_OMISSIONS;
  for (const entry of pack.omitted.slice(0, previewLimit)) {
    lines.push(`  ${"omitted".padEnd(22)} ${entry.path} (${entry.reason}; ${entry.detail})`);
  }

  if (pack.omitted.length > previewLimit) {
    lines.push(
      `  ${pack.omitted.length} omissions total; full ledger: ${pack.artifactRef ?? "context artifact"}#/omitted`,
    );
  }
  if (pack.budgetStatus === "essential-overflow") {
    lines.push(
      "",
      "Required context exceeds the token budget; optional files were omitted. Increase the budget or narrow the task contract before adding more context.",
    );
  }

  if (pack.unknowns.length > 0) {
    lines.push("", "Not known — do not assume:", ...pack.unknowns.map((note) => `  ${note}`));
  }

  return lines;
}

/** The failure this pack answers, printed so a text-only agent still sees it. */
export function renderAttemptFeedback(pack: ContextPack): string[] {
  const feedback = pack.attemptFeedback;
  if (!feedback) return [];

  const lines = [
    "",
    `This rebuild answers a failed ${feedback.source}` +
      (feedback.attempt !== undefined ? ` (attempt ${feedback.attempt})` : "") +
      ":",
  ];

  for (const command of feedback.failingCommands) {
    lines.push(`  ${command.command} exited ${command.exitCode}:`);
    lines.push(...command.output.split("\n").map((line) => `    ${line}`));
  }

  for (const finding of feedback.unresolvedFindings) {
    lines.push(`  finding: ${finding.message}`);
  }

  return lines;
}

/** One honest explanation of graph state for CLI and MCP delivery. */
export function renderGraphStatus(pack: ContextPack): string {
  if (pack.staleIndex) return pack.staleIndex;
  if (pack.graphAvailable) return "";
  if (pack.graphDeferred) {
    return "Repository graph intentionally deferred: no indexable project source exists yet.";
  }
  return "No repository index yet, so selection used file paths only. Run: visp index";
}

/**
 * The model-facing view of a pack: source hashes, and snippet text only when asked
 * for — a reader with file access wants to know where to read, not to receive
 * a second copy of the repository.
 */
export function slimPack(pack: ContextPack, withSnippets: boolean): Record<string, unknown> {
  return {
    feature: pack.feature,
    task: pack.task,
    goal: pack.goal,
    ...(pack.contract ? { contract: pack.contract } : {}),
    ...(pack.skillDiagnostics?.length
      ? {
          skillDiagnostics: pack.skillDiagnostics.slice(0, 8),
          skillDiagnosticCount: pack.skillDiagnostics.length,
        }
      : {}),
    files: pack.files.map((file) => slimFile(file, withSnippets)),
    omitted: pack.omitted.slice(0, pack.omissionPreviewLimit ?? PRINTED_OMISSIONS),
    omittedCount: pack.omitted.length,
    ...(pack.artifactRef ? { omissionsRef: `${pack.artifactRef}#/omitted` } : {}),
    entrypoints: pack.entrypoints,
    unknowns: pack.unknowns,
    ...(pack.attemptFeedback ? { attemptFeedback: pack.attemptFeedback } : {}),
    ...(pack.staleIndex ? { staleIndex: pack.staleIndex } : {}),
    estimatedTokens: pack.estimatedTokens,
    tokenBudget: pack.tokenBudget,
    ...(pack.budgetStatus ? { budgetStatus: pack.budgetStatus } : {}),
    graphAvailable: pack.graphAvailable,
    graphDeferred: pack.graphDeferred === true,
  };
}

/** The default CLI view stays bounded; --full explicitly exports canonical artifacts. */
export function contextJsonView(pack: ContextPack, withSnippets: boolean): Record<string, unknown> {
  return {
    pack: slimPack(pack, withSnippets),
    skippedSkills: pack.skillDiagnostics?.slice(0, 8) ?? [],
    skippedSkillsCount: pack.skillDiagnostics?.length ?? 0,
    ...(pack.artifactRef
      ? {
          path: pack.artifactRef,
          manifestRef: pack.artifactRef.replace(/\.json$/, ".manifest.json"),
        }
      : {}),
  };
}

export function contextNextCommand(pack: ContextPack): string {
  return `visp gate implement --task ${pack.task}`;
}

export function renderContextSummary(pack: ContextPack): string {
  return (
    `Compiled context for ${pack.task}: ${pack.files.length} files, about ${pack.estimatedTokens} tokens of ${pack.tokenBudget}.` +
    (pack.budgetStatus === "essential-overflow"
      ? " Required context exceeds the budget; optional files were omitted."
      : "")
  );
}

/** Includes pretty CLI JSON framing and the MCP summary plus structured payload. */
export function estimateContextResponseTokens(pack: ContextPack, withSnippets: boolean): number {
  const nextCommand = contextNextCommand(pack);
  const cli = {
    command: "context",
    ok: true,
    data: contextJsonView(pack, withSnippets),
    nextCommand,
  };
  const mcp = { tool: "visp_context", ok: true, data: slimPack(pack, withSnippets), nextCommand };
  return Math.max(
    estimateTokens(`${JSON.stringify(cli, null, 2)}\n`),
    estimateTokens(JSON.stringify(mcp)) +
      estimateTokens(`${renderContextSummary(pack)}\n\nNext: ${nextCommand}`),
  );
}

/** Estimate the exact file shape a model receives, including its own cost field. */
export function estimateDeliveredFileTokens(file: ContextFile, withSnippets: boolean): number {
  return stableEstimate((estimatedTokens) =>
    estimateTokens(JSON.stringify(slimFile({ ...file, estimatedTokens }, withSnippets))),
  );
}

/** Estimate the exact model-facing pack rather than fixed framing constants. */
export function estimateDeliveredPackTokens(pack: ContextPack, withSnippets: boolean): number {
  return stableEstimate((estimatedTokens) =>
    estimateTokens(JSON.stringify(slimPack({ ...pack, estimatedTokens }, withSnippets))),
  );
}

function slimFile(file: ContextFile, withSnippets: boolean): Record<string, unknown> {
  return {
    path: file.path,
    reason: file.reason,
    hash: file.hash,
    regions: file.regions,
    estimatedTokens: file.estimatedTokens,
    truncated: file.truncated,
    ...(withSnippets ? { snippets: file.snippets } : {}),
  };
}

function stableEstimate(measure: (estimate: number) => number): number {
  let estimate = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const measured = measure(estimate);
    if (measured === estimate) return measured;
    estimate = measured;
  }
  return estimate;
}
