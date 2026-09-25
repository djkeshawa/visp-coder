import { realpath } from "node:fs/promises";
import { fromUnknown, vispError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { parseProjectFilePath } from "../core/input.js";
import { err, ok, type Result } from "../core/result.js";
import { isoTimestampSchema, now } from "../workflow/artifacts/common.js";
import type { WorkspaceState } from "../workflow/state.js";
import type { UsageSegment } from "./schema.js";
import { recordUsageReceipt, type UsageImportOutcome, type UsageReceipt } from "./store.js";

interface CodexUsage {
  readonly runId: string;
  readonly cwdValues: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly segments: readonly UsageSegment[];
}

interface TokenSnapshot {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

interface CodexAccumulator {
  runId?: string;
  readonly runIds: Set<string>;
  readonly cwdValues: string[];
  readonly timestamps: string[];
  sessionStartedAt?: string;
  model?: string;
  effort?: string;
  tokens?: TokenSnapshot;
  readonly segments: UsageSegment[];
}

/** Imports one explicit Codex rollout. Visp never searches the user's session directory. */
export async function importCodexUsage(
  state: WorkspaceState,
  sourceFile: string,
): Promise<Result<UsageImportOutcome>> {
  const parsedPath = parseProjectFilePath(sourceFile);
  if (!parsedPath.ok) return parsedPath;
  const read = await state.files.readText(parsedPath.value);
  if (!read.ok) return read;
  const raw = read.value;
  const absoluteFile = state.paths.absolute(parsedPath.value);

  const parsed = parseCodexRollout(raw);
  if (!parsed.ok) return parsed;

  const canonical = await canonicalProject(parsed.value.cwdValues, state.paths.root);
  if (!canonical.ok) return canonical;

  const receipt: UsageReceipt = {
    source: "codex",
    runId: parsed.value.runId,
    sourceFile: absoluteFile,
    sourceFileHash: sha256(raw),
    projectRoot: canonical.value,
    startedAt: parsed.value.startedAt,
    endedAt: parsed.value.endedAt,
    importedAt: now(),
    ...(parsed.value.model ? { model: parsed.value.model } : {}),
    ...(parsed.value.effort ? { effort: parsed.value.effort } : {}),
    inputTokens: parsed.value.inputTokens,
    cachedInputTokens: parsed.value.cachedInputTokens,
    outputTokens: parsed.value.outputTokens,
    reasoningTokens: parsed.value.reasoningTokens,
    segments: [...parsed.value.segments],
    attribution: "turn-context",
  };

  return recordUsageReceipt(state, receipt);
}

export function parseCodexRollout(raw: string): Result<CodexUsage> {
  const accumulated: CodexAccumulator = {
    runIds: new Set(),
    cwdValues: [],
    timestamps: [],
    segments: [],
  };

  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;

    const row = parseLine(line, index + 1);
    if (!row.ok) return row;
    const accepted = accumulateRow(accumulated, row.value);
    if (!accepted.ok) return accepted;
  }

  return finish(accumulated);
}

function parseLine(line: string, lineNumber: number): Result<Record<string, unknown>> {
  try {
    const parsed = object(JSON.parse(line));
    return parsed ? ok(parsed) : invalid(`Codex JSONL line ${lineNumber} is not an object`);
  } catch {
    return invalid(`Invalid Codex JSONL at line ${lineNumber}`);
  }
}

function accumulateRow(accumulated: CodexAccumulator, row: Record<string, unknown>): Result<void> {
  const timestamp = timestampOf(row.timestamp);
  if (row.timestamp !== undefined && !timestamp)
    return invalid("Codex rollout contains an invalid timestamp");
  const previousAt = accumulated.timestamps.at(-1);
  if (timestamp && previousAt && Date.parse(timestamp) < Date.parse(previousAt))
    return invalid("Codex rollout timestamps decrease");
  if (timestamp) accumulated.timestamps.push(timestamp);

  const payload = object(row.payload);
  if (!payload) return ok(undefined);

  if (row.type === "session_meta") accumulateSession(accumulated, payload);
  else if (row.type === "turn_context") accumulateContext(accumulated, payload);
  else if (row.type === "event_msg" && payload.type === "token_count") {
    return accumulateTokens(accumulated, payload, timestamp);
  }
  return ok(undefined);
}

function accumulateTokens(
  accumulated: CodexAccumulator,
  payload: Record<string, unknown>,
  at: string | undefined,
): Result<void> {
  const info = object(payload.info);
  if (info?.total_token_usage === undefined) return ok(undefined);
  const tokens = tokenSnapshot(payload);
  if (!tokens || !at) return invalid("Codex rollout has an invalid cumulative token snapshot");
  const previous = accumulated.tokens;
  const delta = {
    inputTokens: tokens.inputTokens - (previous?.inputTokens ?? 0),
    cachedInputTokens: tokens.cachedInputTokens - (previous?.cachedInputTokens ?? 0),
    outputTokens: tokens.outputTokens - (previous?.outputTokens ?? 0),
    reasoningTokens: tokens.reasoningTokens - (previous?.reasoningTokens ?? 0),
  };
  if (Object.values(delta).some((value) => value < 0))
    return invalid("Codex cumulative token counts decrease");
  if (delta.cachedInputTokens > delta.inputTokens || delta.reasoningTokens > delta.outputTokens)
    return invalid("Codex token deltas contain inconsistent subtotals");
  accumulated.tokens = tokens;
  if (Object.values(delta).some((value) => value > 0))
    accumulated.segments.push({
      at,
      ...delta,
      ...(accumulated.model ? { model: accumulated.model } : {}),
      ...(accumulated.effort ? { effort: accumulated.effort } : {}),
    });
  return ok(undefined);
}

function accumulateSession(accumulated: CodexAccumulator, payload: Record<string, unknown>): void {
  const candidate = text(payload.id);
  if (candidate) {
    accumulated.runIds.add(candidate);
    accumulated.runId = candidate;
  }
  accumulated.sessionStartedAt = timestampOf(payload.timestamp) ?? accumulated.sessionStartedAt;
  appendCwd(accumulated, payload);
}

function accumulateContext(accumulated: CodexAccumulator, payload: Record<string, unknown>): void {
  appendCwd(accumulated, payload);
  accumulated.model = text(payload.model) ?? accumulated.model;
  accumulated.effort = text(payload.effort) ?? nestedEffort(payload) ?? accumulated.effort;
}

function appendCwd(accumulated: CodexAccumulator, payload: Record<string, unknown>): void {
  const cwd = text(payload.cwd);
  if (cwd) accumulated.cwdValues.push(cwd);
}

function finish(accumulated: CodexAccumulator): Result<CodexUsage> {
  if (!accumulated.runId) return invalid("Codex rollout has no session_meta run id");
  if (accumulated.runIds.size > 1) return invalid("Codex JSONL contains more than one run id");
  if (accumulated.cwdValues.length === 0) {
    return invalid("Codex rollout records no working directory");
  }
  if (!accumulated.tokens) {
    return invalid("Codex rollout has no cumulative token_count snapshot");
  }

  const startedAt = accumulated.sessionStartedAt ?? accumulated.timestamps[0];
  const endedAt = accumulated.timestamps.at(-1);
  if (!startedAt || !endedAt) return invalid("Codex rollout has no valid timestamps");
  if (Date.parse(endedAt) < Date.parse(startedAt))
    return invalid("Codex rollout ends before it starts");
  const model = uniqueSegmentValue(accumulated, "model");
  const effort = uniqueSegmentValue(accumulated, "effort");

  return ok({
    runId: accumulated.runId,
    cwdValues: accumulated.cwdValues,
    startedAt,
    endedAt,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...accumulated.tokens,
    segments: accumulated.segments,
  });
}

function uniqueSegmentValue(
  accumulated: CodexAccumulator,
  field: "model" | "effort",
): string | undefined {
  if (accumulated.segments.length === 0) return accumulated[field];
  const values = new Set(accumulated.segments.map((segment) => segment[field]));
  return values.size === 1 ? [...values][0] : undefined;
}

async function canonicalProject(
  cwdValues: readonly string[],
  projectRoot: string,
): Promise<Result<string>> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(projectRoot);
  } catch (cause) {
    return err(fromUnknown(cause, "IO_ERROR"));
  }

  for (const cwd of new Set(cwdValues)) {
    let canonicalCwd: string;
    try {
      canonicalCwd = await realpath(cwd);
    } catch (cause) {
      return err(fromUnknown(cause, "IO_ERROR"));
    }
    if (canonicalCwd !== canonicalRoot) {
      return err(
        vispError(
          "ARTIFACT_INVALID",
          `Codex rollout cwd ${canonicalCwd} does not match this project ${canonicalRoot}`,
        ),
      );
    }
  }

  return ok(canonicalRoot);
}

function tokenSnapshot(payload: Record<string, unknown>): TokenSnapshot | undefined {
  const info = object(payload.info);
  const usage = info ? object(info.total_token_usage) : undefined;
  if (!usage) return undefined;

  const inputTokens = count(usage.input_tokens);
  const cachedInputTokens = count(usage.cached_input_tokens);
  const outputTokens = count(usage.output_tokens);
  const reasoningTokens = count(usage.reasoning_output_tokens);
  if (
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    outputTokens === undefined ||
    reasoningTokens === undefined
  ) {
    return undefined;
  }
  if (cachedInputTokens > inputTokens || reasoningTokens > outputTokens) return undefined;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens };
}

function nestedEffort(payload: Record<string, unknown>): string | undefined {
  const collaboration = object(payload.collaboration_mode);
  const settings = collaboration ? object(collaboration.settings) : undefined;
  return settings ? text(settings.reasoning_effort) : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function timestampOf(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate && validTimestamp(candidate) ? candidate : undefined;
}

function validTimestamp(value: string): boolean {
  return isoTimestampSchema.safeParse(value).success;
}

function invalid(message: string): Result<never> {
  return err(vispError("ARTIFACT_INVALID", message));
}
