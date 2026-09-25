import type { ContextFile, ContextRegion } from "../../../../src/workflow/artifacts/context.js";

export interface SnippetOptions {
  readonly maxSnippets: number;
  readonly maxLines: number;
  readonly cap: boolean;
}

export type Snippet = ContextFile["snippets"][number];

export function extractSnippets(
  text: string,
  options: SnippetOptions,
): { snippets: Snippet[]; truncated: boolean } {
  const lines = text.split("\n");
  if (!options.cap || lines.length <= options.maxLines)
    return {
      snippets: [{ startLine: 1, endLine: lines.length, text }],
      truncated: false,
    };

  const regions = interestingRegions(lines, options);
  return {
    snippets: regions.map((region) => ({
      startLine: region.start + 1,
      endLine: region.end,
      text: lines.slice(region.start, region.end).join("\n"),
    })),
    truncated: true,
  };
}

interface Region {
  readonly start: number;
  readonly end: number;
}

function interestingRegions(lines: readonly string[], options: SnippetOptions): Region[] {
  const regions: Region[] = [{ start: 0, end: Math.min(options.maxLines, lines.length) }];
  const declarations = findDeclarationLines(lines).filter((line) => line >= options.maxLines);
  for (const line of declarations) {
    if (regions.length >= options.maxSnippets) break;
    const start = Math.max(0, line - 2);
    const end = Math.min(lines.length, start + options.maxLines);
    if (regions.some((region) => start < region.end && end > region.start)) continue;
    regions.push({ start, end });
  }
  return regions.sort((a, b) => a.start - b.start);
}

const DECLARATION =
  /^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|def|struct|impl)\s/;

function findDeclarationLines(lines: readonly string[]): number[] {
  const found: number[] = [];
  for (const [index, line] of lines.entries()) if (DECLARATION.test(line)) found.push(index);
  return found;
}

export function snippetsAtRegions(
  text: string,
  regions: readonly ContextRegion[],
): { snippets: Snippet[]; truncated: boolean } {
  const lines = text.split("\n");
  const snippets = regions
    .filter((region) => region.startLine <= lines.length)
    .map((region) => {
      const endLine = Math.min(region.endLine, lines.length);
      return {
        startLine: region.startLine,
        endLine,
        text: lines.slice(region.startLine - 1, endLine).join("\n"),
      };
    });
  const covered = snippets.reduce(
    (total, snippet) => total + (snippet.endLine - snippet.startLine + 1),
    0,
  );
  return { snippets, truncated: covered < lines.length };
}

export const FILE_OVERHEAD_TOKENS = 60;

export function estimateFileTokens(file: {
  readonly snippets: readonly { text: string }[];
}): number {
  const text = file.snippets.reduce(
    (total, snippet) => total + Math.ceil(snippet.text.length / 3.3),
    0,
  );
  return text + FILE_OVERHEAD_TOKENS;
}

/**
 * Rough token estimate. Deliberately crude and slightly pessimistic: it exists
 * to keep a pack inside a budget, not to predict a bill. Code tokenises nearer
 * one token per 3.3 characters than the folkloric 4 — a real pack measured
 * ~17% over its own estimate under the old divisor.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.3);
}
