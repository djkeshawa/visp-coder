import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok } from "../../core/result.js";
import { browserJourneySchema } from "../../testing/browser-journey.js";
import type { ProductRecord } from "../product/store.js";
import { productContractDigest } from "../product/subject.js";

const replaySchema = z.object({
  id: z.string(),
  provenance: z.literal("runner-executed"),
  task: z.string().optional(),
  journey: browserJourneySchema,
  journeyDigest: z.string(),
});

export function replayJourney(runs: readonly unknown[], id: string, task?: string) {
  const matches = runs.filter(
    (run) => typeof run === "object" && run !== null && "id" in run && run.id === id,
  );
  const run = matches.length === 1 ? replaySchema.safeParse(matches[0]) : undefined;
  if (!run?.success || hashValue(run.data.journey) !== run.data.journeyDigest)
    return err(
      vispError(
        "CONFIG_INVALID",
        `Run ${id} has no intact replayable journey. Supply the original journey with --from; legacy records are preserved.`,
      ),
    );
  if (task !== undefined && run.data.task !== task)
    return err(
      vispError(
        "TASK_NOT_FOUND",
        `Run ${id} belongs to ${run.data.task ?? "feature-wide capture"}; select that scope before replaying it`,
      ),
    );
  return ok({ journey: run.data.journey, task: run.data.task });
}

const historicalJourney = replaySchema.extend({
  subjectDigest: z.string(),
  contractDigest: z.string(),
  status: z.string(),
  comparisonEnvironment: z.string().optional(),
  failure: z.object({ kind: z.string(), message: z.string() }).optional(),
  captures: z.array(z.object({ id: z.string() })).default([]),
  operations: z
    .array(
      z.object({
        id: z.string(),
        description: z.string().optional(),
        measurement: z.object({ json: z.string(), truncated: z.boolean() }).optional(),
      }),
    )
    .default([]),
});

/** Shared identity checks for replay suggestions and finding-specific rechecks. */
export function recordedReplayRuns(record: ProductRecord, task?: string) {
  const contract = productContractDigest(
    record.brief,
    record.brief.slices.find((slice) => slice.id === task),
  );
  const ids = new Map<string, number>();
  for (const candidate of record.state.captureRuns) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "id" in candidate &&
      typeof candidate.id === "string"
    )
      ids.set(candidate.id, (ids.get(candidate.id) ?? 0) + 1);
  }
  return record.state.captureRuns.flatMap((candidate) => {
    const parsed = historicalJourney.safeParse(candidate);
    if (
      !parsed.success ||
      parsed.data.task !== task ||
      parsed.data.contractDigest !== contract ||
      hashValue(parsed.data.journey) !== parsed.data.journeyDigest ||
      !/^[a-zA-Z0-9_-]+$/.test(parsed.data.id) ||
      ids.get(parsed.data.id) !== 1
    )
      return [];
    return [parsed.data];
  });
}

export function replayCommand(feature: string, runId: string, task?: string) {
  return `visp capture --feature ${feature}${task ? ` --task ${task}` : ""} --replay=${runId}`;
}

/** Optional rechecks use recorded actions; no planning document or new completion requirement. */
export function replaySuggestions(record: ProductRecord, subject: string, task?: string) {
  const latest = new Map<string, z.infer<typeof historicalJourney>>();
  for (const run of recordedReplayRuns(record, task)) {
    latest.delete(run.journeyDigest);
    latest.set(run.journeyDigest, run);
  }
  const pending = [...latest.values()].reverse().filter((run) => run.subjectDigest !== subject);
  if (!pending.length) return undefined;
  return {
    advisory: true,
    guidance:
      "These earlier journeys have not run against the current subject. Reuse the relevant ones after a repair, compare actual behavior and images, and preserve working paths. Also check a relevant adjacent transition affected by the change, such as returning to the prior state or repeating an action; observe the resulting state instead of counting successful commands. This is optional feedback, not a new gate.",
    runs: pending.slice(0, 3).map((run) => ({
      runId: run.id,
      previousStatus: run.status,
      command: replayCommand(record.brief.feature, run.id, task),
    })),
    omitted: Math.max(0, pending.length - 3),
  };
}
