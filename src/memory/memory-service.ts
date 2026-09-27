import { run } from "../core/exec.js";
import { type FileMutation, filePrecondition } from "../core/file-transaction.js";
import { ok, type Result } from "../core/result.js";
import type { WorkspaceState } from "../workflow/state.js";

/**
 * Visp Memory as VISP's long-term store. Weak workers never looked up stored knowledge in a
 * later session; they applied what their request carried. So VISP records what users asked
 * for in earlier features and, when a new feature starts, adds the recorded decisions Visp
 * Memory selects for the new request (none when nothing is relevant enough) to that request.
 */
export const MEMORY_SERVICE_STATE = "state/memory-service.json";
/** Per feature: the recorded decisions its request carries, shown on every `work` reply. */
export const PROJECT_MEMORY_FILE = "project-memory.json";
const MEMORY_HEADING =
  "Recorded decisions from earlier work on this project that relate to this request (they still apply unless this request changes them):";
/** Blocks VISP appended to a request; recording them would echo memory back into itself. */
const APPENDED = [MEMORY_HEADING, "Project rules the user stated for all later work"];
const MIN_CHUNK = 20;
const MAX_CHUNK = 1000;
const TIMEOUT_MS = 60_000;

export interface EarlierFeature {
  readonly feature: string;
  readonly goal: string;
  readonly originalRequest: string;
}

/** Paragraphs and list items of a request: the units a later request can relate to. */
export function requestChunks(request: string): string[] {
  return request
    .split(/\n\s*\n/)
    .filter((block) => !APPENDED.some((heading) => block.trimStart().startsWith(heading)))
    .flatMap((block) => {
      const items = block.split("\n").filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line));
      return items.length ? items.map((line) => line.trim()) : [block.replace(/\s+/g, " ").trim()];
    })
    .filter((chunk) => chunk.length >= MIN_CHUNK)
    .map((chunk) => chunk.slice(0, MAX_CHUNK));
}

/**
 * Records the requests of earlier features not yet recorded. Returns the state update so the
 * caller commits it with the feature; a failed record is retried with the next feature.
 */
export async function recordEarlierRequests(
  workspace: WorkspaceState,
  command: string,
  earlier: readonly EarlierFeature[],
): Promise<Result<FileMutation | undefined>> {
  const path = workspace.paths.stateFile(MEMORY_SERVICE_STATE);
  const before = await workspace.files.readTextIfExists(path);
  if (!before.ok) return before;
  const recorded = new Set<string>(parseRecorded(before.value));
  const added: string[] = [];
  for (const feature of earlier) {
    if (recorded.has(feature.feature)) continue;
    let complete = true;
    for (const chunk of requestChunks(feature.originalRequest)) {
      const saved = await run(
        command,
        ["decision", chunk, `Stated by the user for feature ${feature.feature}: ${feature.goal}`],
        { cwd: workspace.paths.root, timeoutMs: TIMEOUT_MS },
      );
      if (!saved.ok || saved.value.exitCode !== 0) complete = false;
    }
    if (complete) added.push(feature.feature);
  }
  if (added.length === 0) return ok(undefined);
  return ok({
    kind: "write",
    path,
    content: `${JSON.stringify({ version: 1, recorded: [...recorded, ...added] }, null, 2)}\n`,
    expectedBefore: filePrecondition(before.value),
  });
}

/** The recorded decisions a feature's request carries, for its `work` replies. */
export async function featureMemories(
  workspace: WorkspaceState,
  feature: string,
): Promise<string[]> {
  const text = await workspace.files.readTextIfExists(
    workspace.paths.featureFile(feature, PROJECT_MEMORY_FILE),
  );
  if (!text.ok || !text.value) return [];
  try {
    const memories = (JSON.parse(text.value) as { memories?: unknown }).memories;
    return Array.isArray(memories) ? memories.filter((m) => typeof m === "string") : [];
  } catch {
    return [];
  }
}

/** Recorded decisions Visp Memory selects for a request, leaving out what the request already says. */
export async function memoryBriefFor(
  workspace: WorkspaceState,
  command: string,
  request: string,
  tokens?: number,
): Promise<string[]> {
  const budget = tokens ? ["--tokens", String(tokens)] : [];
  const brief = await run(command, ["brief", request, "--format", "json", ...budget], {
    cwd: workspace.paths.root,
    timeoutMs: TIMEOUT_MS,
  });
  if (!brief.ok || brief.value.exitCode !== 0) return [];
  let parsed: { abstained?: boolean; sections?: Record<string, { content?: unknown }[]> };
  try {
    parsed = JSON.parse(brief.value.stdout);
  } catch {
    return [];
  }
  if (parsed.abstained) return [];
  const said = comparable(request);
  return ["warnings", "decisions", "knowledge"]
    .flatMap((section) => parsed.sections?.[section] ?? [])
    .map((memory) => (typeof memory.content === "string" ? memory.content : ""))
    .map((content) =>
      content
        .replace(/\nReasoning: .*$/s, "")
        .replace(/^Decision: /, "")
        .trim(),
    )
    .filter((content) => content && !said.includes(comparable(content)));
}

export function projectMemoryText(memories: readonly string[]): string {
  if (memories.length === 0) return "";
  return [MEMORY_HEADING, ...memories.map((memory, index) => `M${index + 1} ${memory}`)].join("\n");
}

function parseRecorded(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const recorded = (JSON.parse(text) as { recorded?: unknown }).recorded;
    return Array.isArray(recorded) ? recorded.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function comparable(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
