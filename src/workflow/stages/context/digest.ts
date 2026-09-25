import { hashValue } from "../../../core/hash.js";
import type { ContextPack } from "../../artifacts/context.js";

/**
 * Stable evidence identity for the context an agent actually reasoned over.
 * Delivery size, rendered snippets, timestamps, and retry feedback deliberately
 * do not participate; selection, source content, regions, unresolved unknowns,
 * and the repository graph do.
 */
export function stableContextHash(pack: ContextPack, graphSnapshotId?: string): string {
  return hashValue({
    goal: pack.goal,
    ...(pack.contract ? { contract: pack.contract } : {}),
    files: pack.files.map((file) => ({
      path: file.path,
      reason: file.reason,
      hash: file.hash,
      regions: file.regions,
    })),
    omitted: pack.omitted,
    entrypoints: pack.entrypoints,
    unknowns: pack.unknowns,
    graphAvailable: pack.graphAvailable,
    graphDeferred: pack.graphDeferred,
    graphSnapshotId,
    staleIndex: pack.staleIndex,
  });
}
