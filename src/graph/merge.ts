import { isExternalRef } from "./constants.js";
import type { ExtractionOutcome } from "./extract/index.js";
import { compareUnknowns } from "./extract/unknowns.js";
import type { Entity, Entrypoint, GraphSnapshot, Relation, UnknownRecord } from "./types.js";

/**
 * Merging freshly parsed facts with the facts of files that did not change.
 * A relation whose endpoint no longer exists is invalidated and counted, never
 * carried forward as a claim about an entity that is gone.
 */

export interface MergedFacts {
  readonly entities: Entity[];
  readonly relations: Relation[];
  readonly unknowns: UnknownRecord[];
  readonly entrypoints: Entrypoint[];
  readonly reusedParsedPaths: Set<string>;
  readonly invalidated: number;
}

export function mergeFacts(
  fresh: ExtractionOutcome,
  previous: GraphSnapshot | undefined,
  reusablePaths: ReadonlySet<string>,
  livePaths: ReadonlySet<string>,
): MergedFacts {
  const reusedParsedPaths = new Set<string>();
  const entities = [...fresh.entities];
  const relations = [...fresh.relations];
  const unknowns = [...fresh.unknowns];
  const entrypoints = [...fresh.entrypoints];

  if (previous) {
    for (const entity of reusable(previous.entities, reusablePaths)) {
      entities.push(entity);
      if (entity.kind === "file") reusedParsedPaths.add(entity.path);
    }
    relations.push(...reusable(previous.relations, reusablePaths));
    unknowns.push(...reusable(previous.unknowns, reusablePaths));
    entrypoints.push(...reusable(previous.entrypoints, reusablePaths));
  }

  const known = new Set(entities.map((entity) => entity.id));
  const kept = relations.filter((relation) => isLive(relation, known));
  unknowns.push(...danglingUnknowns(relations, known, livePaths));

  return {
    entities: dedupeEntities(entities),
    relations: kept,
    unknowns: dedupeUnknowns(unknowns),
    entrypoints: dedupeEntrypoints(entrypoints),
    reusedParsedPaths,
    invalidated: relations.length - kept.length,
  };
}

function reusable<T extends { readonly path: string }>(
  facts: readonly T[],
  reusablePaths: ReadonlySet<string>,
): T[] {
  return facts.filter((fact) => reusablePaths.has(fact.path));
}

/**
 * A dropped relation from a file that still exists is a gap the caller must
 * see: the file still refers to something the graph can no longer name.
 */
function danglingUnknowns(
  relations: readonly Relation[],
  known: ReadonlySet<string>,
  livePaths: ReadonlySet<string>,
): UnknownRecord[] {
  return relations
    .filter((relation) => !isLive(relation, known) && livePaths.has(relation.path))
    .map((relation) => ({
      kind:
        relation.kind === "calls" ? ("unresolved_call" as const) : ("unresolved_import" as const),
      path: relation.path,
      detail: `${relation.kind} target no longer in graph: ${relation.target}`,
    }));
}

function isLive(relation: Relation, known: ReadonlySet<string>): boolean {
  if (!known.has(relation.source)) return false;
  return isExternalRef(relation.target) || known.has(relation.target);
}

function dedupeEntities(entities: readonly Entity[]): Entity[] {
  const byId = new Map<string, Entity>();
  for (const entity of entities) if (!byId.has(entity.id)) byId.set(entity.id, entity);
  return [...byId.values()].sort(
    (a, b) => compare(a.path, b.path) || a.startLine - b.startLine || compare(a.id, b.id),
  );
}

function dedupeUnknowns(unknowns: readonly UnknownRecord[]): UnknownRecord[] {
  const seen = new Map<string, UnknownRecord>();
  for (const unknown of unknowns) {
    seen.set(`${unknown.kind} ${unknown.path} ${unknown.detail}`, unknown);
  }
  return [...seen.values()].sort(compareUnknowns);
}

function dedupeEntrypoints(entrypoints: readonly Entrypoint[]): Entrypoint[] {
  const seen = new Map<string, Entrypoint>();
  for (const entrypoint of entrypoints) {
    seen.set(
      `${entrypoint.path} ${entrypoint.kind} ${entrypoint.name} ${entrypoint.line}`,
      entrypoint,
    );
  }
  return [...seen.values()].sort(
    (a, b) =>
      compare(a.path, b.path) ||
      a.line - b.line ||
      compare(a.kind, b.kind) ||
      compare(a.name, b.name),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
