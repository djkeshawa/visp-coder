import { PRODUCT_NAME } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import type { GraphStore } from "../store/store.js";
import { queryGraph } from "./index.js";
import type { QueryArgs, QueryOperation } from "./types.js";

/** Shared positional target interpretation for CLI and MCP graph queries. */
export function queryArgs(operation: QueryOperation, target: string | undefined): QueryArgs {
  if (target === undefined) return {};
  switch (operation) {
    case "search":
      return target.includes("/") || target.includes(".") ? { path: target } : { name: target };
    case "testsFor":
    case "impact":
      return { path: target, entity: target };
    case "tracePath":
      return { from: target };
    case "unknowns":
      return { kind: target as QueryArgs["kind"] };
    default:
      return { entity: target, path: target };
  }
}

/** Operations that need one entity rather than a file or a search term. */
const ENTITY_OPERATIONS: readonly QueryOperation[] = ["entity", "callers", "callees", "neighbors"];

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
  if (!ENTITY_OPERATIONS.includes(operation)) return ok(target);

  const found = queryGraph(store, "search", { name: target }, { results: 25 });
  if (!found.ok) return found;

  const candidates = found.value.rows.filter((row) => row.kind === "entity");
  const inFile = candidates.filter((row) => row.path === target);

  // A file names many entities, so ask which one rather than picking for them.
  if (inFile.length > 0 || candidates.length === 0) {
    const named = inFile.length > 0 ? inFile : entitiesInFile(store, target);
    if (named.length > 0) {
      return err(
        vispError("UNSUPPORTED", `${operation} needs one symbol, not a whole file`, {
          recovery: `${PRODUCT_NAME} query ${operation} "${named[0]?.key}"`,
        }),
      );
    }
    return err(
      vispError("ARTIFACT_MISSING", `Nothing in the index matches "${target}"`, {
        recovery: `${PRODUCT_NAME} query search ${target}`,
      }),
    );
  }

  const exact = candidates.find((row) => row.name === target);
  return ok((exact ?? candidates[0])?.key ?? target);
}

function entitiesInFile(store: GraphStore, path: string) {
  const found = queryGraph(store, "search", { path }, { results: 200 });
  return found.ok ? found.value.rows : [];
}
