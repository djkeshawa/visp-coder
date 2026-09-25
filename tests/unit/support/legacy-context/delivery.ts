/** Historical test-fixture builder; never used by the product workflow. */
import { DEFAULT_BLOCKED_PATHS, HARD_IGNORED_DIRS } from "../../../../src/core/constants.js";
import { sha256 } from "../../../../src/core/hash.js";
import { matchesAny } from "../../../../src/core/patterns.js";
import { ok, type Result } from "../../../../src/core/result.js";
import type {
  ContextFile,
  ContextPack,
  ContextRegion,
} from "../../../../src/workflow/artifacts/context.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { legacyContextDefaults } from "./defaults.js";
import { estimateDeliveredFileTokens } from "./render.js";
import { type Candidate, isEssentialContext } from "./select.js";
import { extractSnippets, snippetsAtRegions } from "./snippets.js";

const IGNORED_DIRECTORIES = new Set<string>(HARD_IGNORED_DIRS);

/** Read the selected plan into bounded regions without changing its relevance order. */
export async function readCandidates(
  state: WorkspaceState,
  candidates: readonly Candidate[],
  regionsByPath: Readonly<Record<string, readonly ContextRegion[]>>,
  availableTokens = Number.POSITIVE_INFINITY,
): Promise<Result<{ files: ContextFile[]; omitted: ContextPack["omitted"] }>> {
  const files: ContextFile[] = [];
  const omitted: ContextPack["omitted"] = [];
  let tokens = 0;

  for (const candidate of candidates) {
    if (excludedSource(candidate.path, state)) {
      omitted.push({
        path: candidate.path,
        reason: candidate.reason,
        detail: "excluded from context: blocked, ignored, or configured exclusion path",
      });
      continue;
    }
    if (!isEssentialContext(candidate.reason) && tokens >= availableTokens) {
      omitted.push({
        path: candidate.path,
        reason: candidate.reason,
        detail: "not read: required context used the available budget",
      });
      continue;
    }
    const text = await state.files.readTextIfExists(state.paths.absolute(candidate.path));
    if (!text.ok) return text;
    if (text.value === undefined) {
      omitted.push({
        path: candidate.path,
        reason: candidate.reason,
        detail: missingReason(candidate.path),
      });
      continue;
    }

    const known = regionsByPath[candidate.path] ?? [];
    const { regions, snippets, truncated } =
      known.length > 0 ? fromGraphRegions(text.value, known) : fromRegexWindows(text.value, state);

    const entry: ContextFile = {
      path: candidate.path,
      reason: candidate.reason,
      hash: sha256(text.value),
      regions,
      snippets: legacyContextDefaults.includeSnippets ? snippets : [],
      estimatedTokens: 0,
      truncated,
    };
    const estimatedTokens = estimateDeliveredFileTokens(
      entry,
      legacyContextDefaults.includeSnippets,
    );
    files.push({
      ...entry,
      estimatedTokens,
    });
    tokens += estimatedTokens;
  }

  return ok({ files, omitted });
}

function excludedSource(path: string, state: WorkspaceState): boolean {
  const parts = path.replace(/\\/g, "/").split("/");
  return (
    parts.some(
      (part) => IGNORED_DIRECTORIES.has(part) || matchesAny(part, DEFAULT_BLOCKED_PATHS),
    ) ||
    matchesAny(path, state.config.workflow.blockedPaths) ||
    matchesAny(path, state.config.graph.exclude)
  );
}

function missingReason(path: string): string {
  return /[?*[]/.test(path)
    ? "no repository file matched this declaration"
    : "file is missing; create or restore it if required by the task";
}

function fromGraphRegions(
  text: string,
  known: readonly ContextRegion[],
): Pick<ContextFile, "regions" | "snippets" | "truncated"> {
  const { snippets, truncated } = snippetsAtRegions(text, known);
  return { regions: [...known], snippets, truncated };
}

function fromRegexWindows(
  text: string,
  state: WorkspaceState,
): Pick<ContextFile, "regions" | "snippets" | "truncated"> {
  const { snippets, truncated } = extractSnippets(text, {
    cap: legacyContextDefaults.snippetCap,
    maxSnippets: state.config.context.maxSnippets,
    maxLines: legacyContextDefaults.maxSnippetLines,
  });
  return { regions: regionsOfSnippets(snippets), snippets, truncated };
}

export function regionsOfSnippets(
  snippets: readonly { startLine: number; endLine: number }[],
): ContextRegion[] {
  return snippets.map((snippet) => ({
    startLine: snippet.startLine,
    endLine: snippet.endLine,
  }));
}
