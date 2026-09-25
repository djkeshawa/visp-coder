import { isExternalRef } from "../constants.js";
import { compareUnknowns } from "../extract/unknowns.js";
import { fileEntityId } from "../ids.js";
import type { Entity, RelationKind } from "../types.js";
import { byKey, entityRow } from "./rows.js";
import type { SnapshotIndex } from "./snapshot-index.js";
import type { QueryArgs, QueryBudget, QueryDraft } from "./types.js";
import { TraversalWork } from "./work.js";

type Direction = { readonly incoming: boolean; readonly kinds?: readonly RelationKind[] };
const BOTH: readonly Direction[] = [{ incoming: false }, { incoming: true }];
const DEPENDENCY_KINDS: readonly RelationKind[] = ["imports", "calls", "defines", "contains"];

export function neighbors(index: SnapshotIndex, args: QueryArgs, budget: QueryBudget): QueryDraft {
  return walkFrom(index, args, budget, "neighbors", BOTH);
}

export function callers(index: SnapshotIndex, args: QueryArgs, budget: QueryBudget): QueryDraft {
  return walkFrom(index, args, budget, "callers", [{ incoming: true, kinds: ["calls"] }]);
}

export function callees(index: SnapshotIndex, args: QueryArgs, budget: QueryBudget): QueryDraft {
  return walkFrom(index, args, budget, "callees", [{ incoming: false, kinds: ["calls"] }]);
}

export function impact(index: SnapshotIndex, args: QueryArgs, budget: QueryBudget): QueryDraft {
  return walkFrom(index, args, budget, "impact", [
    { incoming: true, kinds: DEPENDENCY_KINDS },
    { incoming: false, kinds: ["tested_by"] },
  ]);
}

export function testsFor(index: SnapshotIndex, args: QueryArgs, budget: QueryBudget): QueryDraft {
  const seed = resolveSeed(index, args);
  if (!seed) return { rows: [], unknowns: [], notes: [missingNote(args)] };
  const work = new TraversalWork(budget);
  const tests = collectTests(index, seed, work);
  return {
    rows: tests.map((test) => entityRow(test, 1)).sort(byKey),
    unknowns: index.unknownsFor([seed.path]).sort(compareUnknowns),
    work: work.receipt(),
    notes: work.receipt().truncated
      ? work.notes()
      : tests.length === 0
        ? [`no test file imports ${seed.path}`]
        : [],
  };
}

function collectTests(index: SnapshotIndex, seed: Entity, work: TraversalWork): Entity[] {
  const seen = new Set<string>();
  for (const id of new Set([seed.id, fileEntityId(seed.path)])) {
    if (!work.visit()) break;
    for (const target of adjacent(index, id, work, [{ incoming: false, kinds: ["tested_by"] }])) {
      if (seen.has(target)) continue;
      if (!work.visit()) break;
      seen.add(target);
    }
    if (work.receipt().truncated) break;
  }
  return [...seen]
    .map((id) => index.entity(id))
    .filter((entity): entity is Entity => entity !== undefined);
}

export function tracePath(index: SnapshotIndex, args: QueryArgs, budget: QueryBudget): QueryDraft {
  const from = args.from ? index.resolveTarget(args.from) : undefined;
  const to = args.to ? index.resolveTarget(args.to) : undefined;
  if (!from || !to) {
    return {
      rows: [],
      unknowns: [],
      notes: [`tracePath needs two known entities; missing ${!from ? args.from : args.to}`],
    };
  }
  const work = new TraversalWork(budget);
  const { parents } = walk(index, from.id, budget.depth, work, BOTH, to.id);
  if (!parents.has(to.id)) {
    return {
      rows: [],
      unknowns: index.unknownsFor([from.path, to.path]).sort(compareUnknowns),
      work: work.receipt(),
      notes: work.receipt().truncated ? work.notes() : [`no path within depth ${budget.depth}`],
    };
  }
  const rows = rebuild(parents, to.id)
    .map((id, position) => {
      const entity = index.entity(id);
      return entity ? entityRow(entity, position) : undefined;
    })
    .filter((row): row is NonNullable<typeof row> => row !== undefined);
  return {
    rows,
    unknowns: index.unknownsFor(rows.map((row) => row.path)).sort(compareUnknowns),
    work: work.receipt(),
    notes: work.notes(),
  };
}

function walkFrom(
  index: SnapshotIndex,
  args: QueryArgs,
  budget: QueryBudget,
  label: string,
  directions: readonly Direction[],
): QueryDraft {
  const seed = resolveSeed(index, args);
  if (!seed) return { rows: [], unknowns: [], notes: [missingNote(args)] };
  const work = new TraversalWork(budget);
  const { distances } = walk(index, seed.id, budget.depth, work, directions);
  distances.delete(seed.id);
  const rows = [...distances.entries()]
    .map(([id, distance]) => {
      const entity = index.entity(id);
      return entity ? entityRow(entity, distance) : undefined;
    })
    .filter((row): row is NonNullable<typeof row> => row !== undefined)
    .sort(byKey);
  return {
    rows,
    unknowns: index
      .unknownsFor(new Set([seed.path, ...rows.map((row) => row.path)]))
      .sort(compareUnknowns),
    work: work.receipt(),
    notes: work.receipt().truncated
      ? work.notes()
      : rows.length === 0
        ? [`${label}: nothing within depth ${budget.depth}`]
        : [],
  };
}

/** Lazy expansion counts edges before filtering and never allocates a full neighbor list. */
function* adjacent(
  index: SnapshotIndex,
  id: string,
  work: TraversalWork,
  directions: readonly Direction[],
): Generator<string> {
  for (const direction of directions) {
    yield* directionalEdges(index, id, work, direction);
    if (work.receipt().truncated) return;
  }
}

function* directionalEdges(
  index: SnapshotIndex,
  id: string,
  work: TraversalWork,
  { incoming, kinds }: Direction,
): Generator<string> {
  for (const relation of incoming ? index.in(id) : index.out(id)) {
    if (!work.examine()) return;
    if (kinds && !kinds.includes(relation.kind)) continue;
    yield incoming ? relation.source : relation.target;
  }
}

function walk(
  index: SnapshotIndex,
  start: string,
  depth: number,
  work: TraversalWork,
  directions: readonly Direction[],
  goal?: string,
): { distances: Map<string, number>; parents: Map<string, string | undefined> } {
  const distances = new Map<string, number>();
  const parents = new Map<string, string | undefined>();
  work.visit();
  distances.set(start, 0);
  parents.set(start, undefined);
  if (start === goal) return { distances, parents };
  let frontier = [start];
  for (let hop = 1; hop <= depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      if (expandNode(index, id, hop, work, directions, { distances, parents }, next, goal)) {
        return { distances, parents };
      }
    }
    frontier = next;
  }
  return { distances, parents };
}

interface WalkState {
  readonly distances: Map<string, number>;
  readonly parents: Map<string, string | undefined>;
}

function expandNode(
  index: SnapshotIndex,
  id: string,
  hop: number,
  work: TraversalWork,
  directions: readonly Direction[],
  state: WalkState,
  next: string[],
  goal?: string,
): boolean {
  for (const neighbor of adjacent(index, id, work, directions)) {
    if (isExternalRef(neighbor) || state.distances.has(neighbor)) continue;
    if (!work.visit()) return true;
    state.distances.set(neighbor, hop);
    state.parents.set(neighbor, id);
    if (neighbor === goal) return true;
    next.push(neighbor);
  }
  return work.receipt().truncated;
}

function rebuild(parents: Map<string, string | undefined>, to: string): string[] {
  const path: string[] = [];
  let cursor: string | undefined = to;
  while (cursor !== undefined) {
    path.unshift(cursor);
    cursor = parents.get(cursor);
  }
  return path;
}

function resolveSeed(index: SnapshotIndex, args: QueryArgs): Entity | undefined {
  const reference = args.entity ?? args.path;
  return reference ? index.resolveTarget(reference) : undefined;
}

function missingNote(args: QueryArgs): string {
  const reference = args.entity ?? args.path;
  return reference
    ? `no entity named ${reference} in this snapshot`
    : "an entity id or path is required";
}
