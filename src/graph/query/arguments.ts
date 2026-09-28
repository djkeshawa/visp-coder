import { PRODUCT_NAME } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import { GENERATED_AGENT_PREFIXES } from "../paths.js";
import type { GraphStore } from "../store/store.js";
import { getQueryIndex } from "./index.js";
import type { QueryArgs, QueryOperation } from "./types.js";

/** Shared positional target interpretation for CLI and MCP graph queries. */
export function queryArgs(
  operation: QueryOperation,
  target: string | undefined,
  to?: string,
): QueryArgs {
  if (target === undefined) return {};
  switch (operation) {
    case "search":
      return target.includes("/") || target.includes(".") ? { path: target } : { name: target };
    case "testsFor":
    case "impact":
      return { path: target, entity: target };
    case "tracePath":
      return { from: target, to };
    case "unknowns":
      return { kind: target as QueryArgs["kind"] };
    default:
      return { entity: target, path: target };
  }
}

/** Resolve both endpoints once and retain the selected IDs in the answer. */
export function resolveQueryInput(
  store: GraphStore,
  operation: QueryOperation,
  target: string | undefined,
  to?: string,
): Result<{ readonly args: QueryArgs; readonly notes: string[] }> {
  const from = resolveQueryTarget(store, operation, target);
  if (!from.ok) return from;
  const destination = operation === "tracePath" ? resolveQueryTarget(store, operation, to) : ok(to);
  if (!destination.ok) return destination;
  const notes: string[] = [];
  if (from.value !== target && from.value !== undefined)
    notes.push(`Resolved ${target} to ${from.value}`);
  if (destination.value !== to && destination.value !== undefined)
    notes.push(`Resolved ${to} to ${destination.value}`);
  return ok({ args: queryArgs(operation, from.value, destination.value), notes });
}

/** Operations that need one entity rather than a file or a search term. */
const ENTITY_OPERATIONS: readonly QueryOperation[] = ["entity", "callers", "callees", "tracePath"];

/**
 * Turns what a person types into what the engine needs. Naming a file or a
 * symbol is the natural thing to do, so those are resolved to an entity here
 * instead of silently returning nothing.
 */
export function resolveQueryTarget(
  store: GraphStore,
  operation: QueryOperation,
  target: string | undefined,
): Result<string | undefined> {
  if (target === undefined || target.includes("#")) return ok(target);
  if (!ENTITY_OPERATIONS.includes(operation) && operation !== "neighbors") return ok(target);

  const indexed = getQueryIndex(store);
  if (!indexed.ok) return indexed;
  const index = indexed.value;
  if (
    (operation === "neighbors" || operation === "tracePath") &&
    index.resolveTarget(target)?.kind === "file"
  )
    return ok(target);
  const matches = index.snapshot.entities.filter(
    (entity) => entity.kind !== "file" && entity.name === target,
  );
  const authored = matches.filter(
    (entity) => !GENERATED_AGENT_PREFIXES.some((prefix) => entity.path.startsWith(prefix)),
  );
  const candidates = authored.length > 0 ? authored : matches;
  const inFile = index.byPath.get(target)?.filter((entity) => entity.kind !== "file") ?? [];

  // A file names many entities, so ask which one rather than picking for them.
  if (inFile.length > 0 || candidates.length === 0) {
    const named = inFile;
    if (named.length > 0) {
      return err(
        vispError("UNSUPPORTED", `${operation} needs one symbol, not a whole file`, {
          recovery: `${PRODUCT_NAME} query ${operation} "${named[0]?.id}"`,
        }),
      );
    }
    return err(
      vispError("ARTIFACT_MISSING", `Nothing in the index matches "${target}"`, {
        recovery: `${PRODUCT_NAME} query search ${target}`,
      }),
    );
  }

  if (candidates.length > 1) {
    const ids = candidates.map((candidate) => candidate.id).sort();
    return err(
      vispError("AMBIGUOUS", `Multiple symbols named "${target}": ${ids.join(", ")}`, {
        recovery: `${PRODUCT_NAME} query ${operation} "${ids[0]}"`,
        details: { candidates: ids },
      }),
    );
  }
  return ok(candidates[0]?.id);
}
