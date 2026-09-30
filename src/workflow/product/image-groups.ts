import { z } from "zod";
import { hashValue } from "../../core/hash.js";
import type { ProductReviewCapture } from "../evidence/product-review.js";
import type { ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";

export interface ProductReviewImageGroup {
  readonly id: string;
  readonly runId?: string;
  readonly task?: string;
  readonly runStatus?: string;
  /** Identity of the journey that produced the run; identical replays share it. */
  readonly journeyKey?: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly captureIds: readonly string[];
}

const runSchema = z.object({
  id: z.string().optional(),
  version: z.union([z.literal(1), z.literal(2)]),
  provenance: z.literal("runner-executed"),
  subjectDigest: z.string(),
  contractDigest: z.string().optional(),
  task: z.string().optional(),
  journeyKey: z.string().optional(),
  status: z.string().optional(),
  failure: z.object({ kind: z.string() }).optional(),
  createdAt: z.string().optional(),
  captures: z.array(
    z.object({
      id: z.string(),
      steps: z.array(z.string()).optional(),
      viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
    }),
  ),
});

/** Runs, including failed runs, supply grouping only; grouping never proves coverage. */
export function productReviewImageGroups(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
): ProductReviewImageGroup[] {
  const runs = record.state.captureRuns.flatMap((candidate, index) => {
    const parsed = runSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.subjectDigest !== subject) return [];
    const run = parsed.data;
    const owner = record.brief.slices.find((entry) => entry.id === run.task);
    if (run.task && !owner) return [];
    if (run.version === 2 && !run.contractDigest) return [];
    if (run.contractDigest && run.contractDigest !== productContractDigest(record.brief, owner))
      return [];
    if (slice && owner && !owner.outcomes.some((id) => slice.outcomes.includes(id))) return [];
    return [{ ...run, index }];
  });
  runs.sort(
    (a, b) =>
      (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0) ||
      b.index - a.index,
  );
  // Runs are newest first. An older group is dropped only for a truly identical replay: same journey,
  // outcome, failure kind and capture steps at the same viewport. A failed or cancelled run never
  // stands in for a completed one, and a run with other captures adds a picture.
  const replays = new Set<string>();
  return runs.flatMap((run) => {
    const viewports = new Map<string, typeof run.captures>();
    for (const capture of run.captures) {
      const key = `${capture.viewport.width}x${capture.viewport.height}`;
      const entries = viewports.get(key) ?? [];
      entries.push(capture);
      viewports.set(key, entries);
    }
    return [...viewports].flatMap(([viewport, captures]) => {
      if (run.journeyKey !== undefined) {
        const replay = replayKey(run, viewport, captures);
        if (replays.has(replay)) return [];
        replays.add(replay);
      }
      return [
        {
          id: `image-group:${run.id ?? hashValue(run.captures).slice(0, 16)}:${viewport}`,
          runId: run.id,
          task: run.task,
          runStatus: run.status,
          ...(run.journeyKey === undefined ? {} : { journeyKey: run.journeyKey }),
          viewport: captures[0]?.viewport ?? { width: 0, height: 0 },
          captureIds: [...new Set(captures.map((capture) => capture.id))],
        },
      ];
    });
  });
}

interface ReplayFacts {
  readonly journeyKey?: unknown;
  readonly status?: unknown;
  readonly failure?: { readonly kind?: unknown };
}

/** Two runs replay each other only when journey, outcome, failure kind and capture steps all agree. */
function replayKey(
  run: ReplayFacts,
  viewport: string,
  captures: readonly { readonly steps?: readonly string[] }[],
): string {
  return JSON.stringify([
    run.journeyKey,
    viewport,
    run.status ?? null,
    run.failure?.kind ?? null,
    captures.map((capture) => capture.steps ?? []),
  ]);
}

/** The newest run of each identical replay (else of each run id), so replays do not crowd out other journeys. */
export function newestRunPerJourney<T>(runs: readonly T[], limit: number): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (let index = runs.length - 1; index >= 0 && kept.length < limit; index--) {
    const run = runs[index] as T;
    const facts = (typeof run === "object" && run !== null ? run : {}) as ReplayFacts & {
      id?: unknown;
      captures?: readonly { steps?: readonly string[] }[];
    };
    const key =
      typeof facts.journeyKey === "string"
        ? replayKey(facts, "", Array.isArray(facts.captures) ? facts.captures : [])
        : typeof facts.id === "string"
          ? facts.id
          : undefined;
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.unshift(run);
  }
  return kept;
}

export interface ImageDeliveryCandidate {
  readonly group?: ProductReviewImageGroup;
  readonly captureIds: readonly string[];
  readonly omittedCaptureIds: readonly string[];
}

/** Favor requested groups, then a journey at each recorded viewport, then other captures. */
export function imageDeliveryCandidates(
  captures: readonly ProductReviewCapture[],
  groups: readonly ProductReviewImageGroup[],
  references: readonly string[],
): ImageDeliveryCandidate[] {
  const preferred = new Map([...new Set(references)].map((id, index) => [id, index]));
  const known = new Map(captures.map((capture) => [capture.id, capture]));
  const rankCapture = (id: string) =>
    preferred.get(id) ?? preferred.get(known.get(id)?.path ?? "") ?? preferred.size;
  const grouped = new Set(groups.flatMap((group) => group.captureIds));
  const seenViewports = new Set<string>();
  const journeysByViewport = new Map<string, Set<string>>();
  const viewportCount = new Set(groups.map((group) => JSON.stringify(group.viewport))).size;
  const ranked = groups.map((group, index) => {
    const key = JSON.stringify(group.viewport);
    const repeatedViewport = seenViewports.has(key);
    seenViewports.add(key);
    // A later group that shows a journey not yet shown at this viewport is as informative as a primary.
    const journeys = journeysByViewport.get(key) ?? new Set<string>();
    journeysByViewport.set(key, journeys);
    const distinctJourney =
      repeatedViewport && group.journeyKey !== undefined && !journeys.has(group.journeyKey);
    if (group.journeyKey !== undefined) journeys.add(group.journeyKey);
    const rank = group.captureIds.reduce(
      (best, id) => Math.min(best, rankCapture(id)),
      preferred.get(group.id) ?? preferred.size,
    );
    const maximum = rank < preferred.size || viewportCount < 2 ? 6 : 3;
    const selected = selectGroupCaptures(group.captureIds, rankCapture, preferred.size, maximum);
    return {
      group,
      captureIds: selected,
      omittedCaptureIds: group.captureIds.filter((id) => !selected.includes(id)),
      rank,
      priority: repeatedViewport ? (distinctJourney ? 1 : 2) : 0,
      index,
    };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.priority - b.priority || a.index - b.index);
  if (!preferred.size && ranked.length > 1) balanceJourneySamples(ranked, rankCapture);
  const single = captures
    .filter((capture) => !grouped.has(capture.id))
    .map((capture, index) => ({
      captureIds: [capture.id],
      omittedCaptureIds: [],
      rank: rankCapture(capture.id),
      index,
    }));
  return [...ranked, ...single].sort((a, b) => a.rank - b.rank);
}

function selectGroupCaptures(
  ids: readonly string[],
  rank: (id: string) => number,
  unrequested: number,
  maximum: number,
): string[] {
  if (ids.length <= maximum) return [...ids];
  const endpoints = [ids[0], ids.at(-1)].filter((id): id is string => id !== undefined);
  const selected = new Set(endpoints);
  for (const id of [...ids].sort((a, b) => rank(a) - rank(b)))
    if (rank(id) < unrequested && selected.size < maximum) selected.add(id);
  for (let index = 1; index < maximum - 1; index++) {
    const id = ids[Math.round((index * (ids.length - 1)) / (maximum - 1))];
    if (id && selected.size < maximum) selected.add(id);
  }
  return ids.filter((id) => selected.has(id));
}

/**
 * Reserve journey endpoints across viewports and distinct journeys before spending spare slots on
 * intermediate states. Groups that only repeat a journey already shown keep their own sample.
 */
function balanceJourneySamples(
  candidates: Array<
    ImageDeliveryCandidate & {
      priority: number;
      captureIds: string[];
      omittedCaptureIds: string[];
    }
  >,
  rank: (id: string) => number,
) {
  const participants = candidates.filter((entry) => entry.priority < 2);
  const quotas = new Map<(typeof participants)[number], number>();
  let remaining = 6;
  for (const entry of participants) {
    const minimum = Math.min(2, entry.captureIds.length);
    if (minimum > remaining) continue;
    quotas.set(entry, minimum);
    remaining -= minimum;
  }
  for (const entry of participants) {
    const minimum = quotas.get(entry);
    if (minimum === undefined) continue;
    const extra = Math.min(remaining, entry.captureIds.length - minimum);
    quotas.set(entry, minimum + extra);
    remaining -= extra;
  }
  for (const [entry, maximum] of quotas) {
    if (!entry.group) continue;
    entry.captureIds = selectGroupCaptures(entry.group.captureIds, rank, 0, maximum);
    entry.omittedCaptureIds = entry.group.captureIds.filter((id) => !entry.captureIds.includes(id));
  }
}
