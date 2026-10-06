import { sha256 } from "../../core/hash.js";
import type { ProductEvidenceReference } from "./evidence-references.js";
import { deliveredEvidenceIdsSchema } from "./review-delivery-validation.js";
import { fitReviewDiff, REVIEW_DIFF_BUDGET } from "./review-diff.js";
import { reviewExcerpt } from "./review-excerpts.js";
import type { ProductSource } from "./sources.js";

export const REVIEW_SOURCE_BUDGET = 32000;
const REVIEW_LIMITATION_BUDGET = 8000;

function sourceCost(source: ProductSource) {
  return JSON.stringify(source).length + 1;
}

async function fitSource(source: ProductSource, text: string, question: string, budget: number) {
  const complete = { ...source, excerpt: text, nextRead: undefined };
  if (sourceCost(complete) <= budget) return complete;
  if (source.kind === "executed-check" || !source.available) return undefined;
  let limit = Math.max(0, budget - sourceCost({ ...source, excerpt: "" }) - 400);
  while (limit > 0) {
    const selected = await reviewExcerpt(source.reference, text, question, limit);
    const fitted = {
      ...source,
      excerpt: selected.excerpt,
      truncated: true,
      omittedRegions: [
        ...(source.coreOutcomes === undefined ? (source.omittedRegions ?? []) : []),
        ...selected.omitted,
      ],
      nextRead: undefined,
    };
    if (sourceCost(fitted) <= budget) return fitted;
    limit = Math.floor(limit * 0.75);
  }
  return undefined;
}

function coreLimitations(core: readonly ProductSource[], delivered: readonly ProductSource[]) {
  const byId = new Map(delivered.map((source) => [source.id, source]));
  const limited = core.filter((source) => {
    const supplied = byId.get(source.id);
    return !supplied?.available || supplied.truncated || !supplied.excerpt;
  });
  if (!limited.length) return undefined;
  const outcomes = [...new Set(limited.flatMap((source) => source.coreOutcomes ?? []))];
  return {
    id: "CODE-CORE-GAPS",
    kind: "implementation-file" as const,
    reference: "Required-outcome source limitations",
    sha256: "",
    available: false,
    excerpt: `Outcomes whose implementation cannot be fully assessed from delivered source: ${outcomes.join(", ") || "product entry points"}. Core files are missing or supplied only as symbol excerpts. Limited candidates: ${limited.length}; identity digest: ${sha256(JSON.stringify(limited.map((source) => [source.id, source.reference, source.sha256])))}; first files: ${limited
      .slice(0, 8)
      .map((source) => source.reference.slice(0, 160))
      .join(
        ", ",
      )}. Omitted regions are not evidence of correctness; report the affected outcomes as uncertain unless other supplied evidence establishes the specific behavior.`,
  };
}

function fullSource(source: ProductSource, text: string) {
  return { ...source, excerpt: text, truncated: false, omittedRegions: [], nextRead: undefined };
}

function fullCoreSources(core: readonly ProductSource[], fullText: ReadonlyMap<string, string>) {
  return core.map((source) =>
    source.available && fullText.has(source.id)
      ? fullSource(source, fullText.get(source.id) ?? "")
      : { ...source, nextRead: undefined },
  );
}

async function deliverCore(
  core: readonly ProductSource[],
  fullText: ReadonlyMap<string, string>,
  question: string,
  budget: number,
) {
  const delivered: ProductSource[] = [];
  const full = fullCoreSources(core, fullText);
  const compacted = compactFullSources(full);
  if (compacted.reduce((cost, source) => cost + sourceCost(source), 0) <= budget) return compacted;
  for (const [index, original] of full.entries()) {
    const source = duplicateSource(original, delivered);
    const share = Math.floor(budget / (core.length - index));
    const fitted = await fitSource(source, source.excerpt, `${question} ${source.excerpt}`, share);
    if (fitted) {
      delivered.push(fitted);
      budget -= sourceCost(fitted);
    }
  }
  return delivered;
}

function duplicateSource(source: ProductSource, delivered: readonly ProductSource[]) {
  if (!source.available || source.truncated) return source;
  const output = (entry: ProductSource) =>
    entry.kind === "executed-check" ? entry.excerpt.split("\n").slice(1).join("\n") : entry.excerpt;
  const previous = delivered.find(
    (entry) =>
      entry.available &&
      !entry.truncated &&
      entry.kind === source.kind &&
      output(entry) === output(source) &&
      (source.kind === "executed-check" || entry.sha256 === source.sha256),
  );
  return previous
    ? {
        ...source,
        excerpt:
          (source.kind === "executed-check" ? `${source.excerpt.split("\n")[0]}\n` : "") +
          `Identical evidence bytes/output supplied once at ${previous.id} (${previous.reference}).`,
        omittedRegions: [],
        nextRead: undefined,
      }
    : source;
}

/** Only emit this plan when all its targets fit together; otherwise fit against delivered targets. */
function compactFullSources(input: readonly ProductSource[]) {
  const compacted: ProductSource[] = [];
  for (const source of input) compacted.push(duplicateSource(source, compacted));
  return compacted;
}

/** Exact required evidence must fit before reserving a reviewer call. */
export async function deliveredSources(
  input: readonly ProductSource[],
  fullText: ReadonlyMap<string, string>,
) {
  const diffs = input.filter((source) => source.kind === "implementation-diff");
  input = input.filter((source) => source.kind !== "implementation-diff");
  const core = input.filter((source) => source.coreOutcomes !== undefined);
  const availableCore = core.filter((source) => source.available);
  const required = input.filter(
    (source) =>
      !source.available ||
      (source.coreOutcomes === undefined &&
        (source.kind === "preserved-request" || source.kind === "executed-check")),
  );
  const secondary = input.filter((source) => !core.includes(source) && !required.includes(source));
  const question = required.map((source) => source.excerpt).join(" ");
  const delivered: ProductSource[] = [];
  let remaining = REVIEW_SOURCE_BUDGET - 2;
  for (const source of required) {
    const supplied = duplicateSource(source, delivered);
    if (sourceCost(supplied) > remaining)
      throw new Error(
        "Required review output or limitation exceeds the serialized source budget; no review call spent.",
      );
    delivered.push(supplied);
    remaining -= sourceCost(supplied);
  }
  remaining = appendReviewDiffs(delivered, diffs, remaining, coreLimitations(core, []));
  const full = compactFullSources(fullCoreSources(availableCore, fullText));
  const fits =
    !coreLimitations(core, full) &&
    full.reduce((cost, source) => cost + sourceCost(source), 0) <= remaining;
  const possibleGap = !fits ? coreLimitations(core, []) : undefined;
  const reserve = possibleGap ? sourceCost(possibleGap) : 0;
  if (reserve > REVIEW_LIMITATION_BUDGET || reserve > remaining)
    throw new Error(
      "Exact core outcome limitations exceed the review source budget; no review call spent.",
    );
  const primary = await deliverCore(availableCore, fullText, question, remaining - reserve);
  delivered.push(...primary);
  remaining -= primary.reduce((cost, source) => cost + sourceCost(source), 0);
  const gap = coreLimitations(core, [...delivered]);
  remaining = appendCoreLimitations(delivered, gap, remaining);
  for (const source of secondary) {
    const supplied = duplicateSource(source, delivered);
    const fitted = await fitSource(supplied, supplied.excerpt, question, remaining);
    if (fitted) {
      delivered.push(fitted);
      remaining -= sourceCost(fitted);
    }
  }
  assertReviewSourceBudget(delivered);
  return JSON.parse(JSON.stringify(delivered)) as ProductSource[];
}

export function assertReviewSourceBudget(sources: readonly ProductSource[]) {
  if (JSON.stringify(sources).length > REVIEW_SOURCE_BUDGET)
    throw new Error("Serialized review sources exceed the source budget; no review call spent.");
}

// Images have a separate byte budget. This bounds the serialized text and response schema.
export const REVIEW_PACKET_BUDGET = 256000;
export function reviewPacketBudgetGap(packet: unknown, ids?: readonly string[]) {
  if (ids && !deliveredEvidenceIdsSchema.safeParse(ids).success)
    return "Delivered evidence IDs exceed the metadata budget; no review call spent.";
  const serialized = JSON.stringify(packet, reviewTextOnly, 2);
  // Reserve wrapper instructions and image path encoding before any dispatch.
  return serialized.length + 8000 > REVIEW_PACKET_BUDGET
    ? "Serialized review packet exceeds the text budget; no review call spent."
    : undefined;
}

function reviewTextOnly(_key: string, value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "mimeType" in value &&
    typeof value.mimeType === "string" &&
    value.mimeType.startsWith("image/") &&
    "data" in value &&
    typeof value.data === "string"
  ) {
    const { data: _data, ...metadata } = value;
    return metadata;
  }
  return value;
}

/** Keep receipt ownership/status, but supply repeated stdout only in its delivered check source. */
export function deliveredSourceEvidence(
  evidence: readonly ProductEvidenceReference[],
  candidate: readonly ProductSource[],
  delivered: readonly ProductSource[],
) {
  const candidates = new Set(candidate.map((source) => source.id));
  const ids = new Set(delivered.map((source) => source.id));
  const summaries = new Map(
    delivered
      .filter((source) => source.kind === "executed-check")
      .flatMap((source) => {
        const receipt = evidence.find((entry) => entry.id === source.id);
        const output = receipt?.summary.split("\n").slice(1).join("\n");
        return receipt && output !== undefined && source.excerpt.includes(output)
          ? [[`${receipt.status}:${receipt.summary}`, source.id] as const]
          : [];
      }),
  );
  return evidence
    .filter((entry) => !candidates.has(entry.id) || ids.has(entry.id))
    .map((entry) => {
      const source = summaries.get(`${entry.status}:${entry.summary}`);
      return source && entry.kind === "execution" && !entry.historicalFailure
        ? {
            ...entry,
            summary: `${entry.summary.split("\n")[0]}\nRecorded results/output supplied once at ${source}.`,
          }
        : entry;
    });
}

function appendCoreLimitations(
  delivered: ProductSource[],
  gap: ProductSource | undefined,
  remaining: number,
) {
  if (gap) {
    if (sourceCost(gap) > remaining)
      throw new Error(
        "Exact core outcome limitations exceed the review source budget; no review call spent.",
      );
    const previous = delivered.find((source) => source.id === gap.id);
    if (previous) {
      const combined = { ...previous, excerpt: `${previous.excerpt}\n${gap.excerpt}` };
      const extra = sourceCost(combined) - sourceCost(previous);
      if (extra > remaining)
        throw new Error(
          "Exact core outcome limitations exceed the review source budget; no review call spent.",
        );
      delivered[delivered.indexOf(previous)] = combined;
      remaining -= extra;
    } else {
      delivered.push(gap);
      remaining -= sourceCost(gap);
    }
  }
  return remaining;
}

function appendReviewDiffs(
  delivered: ProductSource[],
  diffs: readonly ProductSource[],
  remaining: number,
  gap: ProductSource | undefined,
) {
  const reserve = gap ? sourceCost(gap) : 0;
  for (const source of diffs) {
    const fitted = fitReviewDiff(source, Math.min(REVIEW_DIFF_BUDGET, remaining - reserve));
    if (fitted) {
      const firstImplementation = delivered.findIndex(
        (entry) => entry.kind === "implementation-file",
      );
      delivered.splice(firstImplementation < 0 ? delivered.length : firstImplementation, 0, fitted);
      remaining -= sourceCost(fitted);
    }
  }
  return remaining;
}
