import { fileEntityId } from "../ids.js";
import type { Entity, GraphSnapshot, Relation, UnknownRecord } from "../types.js";

/** Adjacency for one snapshot. Every list keeps snapshot order, so traversals are stable. */
export class SnapshotIndex {
  readonly byId = new Map<string, Entity>();
  readonly byPath = new Map<string, Entity[]>();
  readonly outgoing = new Map<string, Relation[]>();
  readonly incoming = new Map<string, Relation[]>();
  readonly unknownsByPath = new Map<string, UnknownRecord[]>();

  constructor(readonly snapshot: GraphSnapshot) {
    for (const entity of snapshot.entities) {
      this.byId.set(entity.id, entity);
      push(this.byPath, entity.path, entity);
    }
    for (const relation of snapshot.relations) {
      push(this.outgoing, relation.source, relation);
      push(this.incoming, relation.target, relation);
    }
    for (const unknown of snapshot.unknowns) {
      push(this.unknownsByPath, unknown.path, unknown);
    }
  }

  out(id: string): Relation[] {
    return this.outgoing.get(id) ?? [];
  }

  in(id: string): Relation[] {
    return this.incoming.get(id) ?? [];
  }

  entity(id: string): Entity | undefined {
    return this.byId.get(id);
  }

  /** Accepts an entity id or a repository path, so callers need not know which they hold. */
  resolveTarget(reference: string): Entity | undefined {
    return this.byId.get(reference) ?? this.byId.get(fileEntityId(reference));
  }

  unknownsFor(paths: Iterable<string>): UnknownRecord[] {
    const seen = new Set<string>();
    const found: UnknownRecord[] = [];
    for (const path of paths) {
      for (const unknown of this.unknownsByPath.get(path) ?? []) {
        const key = `${unknown.kind} ${unknown.path} ${unknown.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(unknown);
      }
    }
    return found;
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
