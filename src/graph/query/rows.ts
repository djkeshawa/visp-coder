import type { Entity, Entrypoint, Relation } from "../types.js";
import type { QueryRow } from "./types.js";

export function entityRow(entity: Entity, distance?: number): QueryRow {
  return {
    kind: "entity",
    key: entity.id,
    path: entity.path,
    name: entity.name,
    detail: entity.kind,
    startLine: entity.startLine,
    endLine: entity.endLine,
    ...(distance === undefined ? {} : { distance }),
  };
}

export function relationRow(relation: Relation): QueryRow {
  return {
    kind: "relation",
    key: `${relation.path}:${relation.line}:${relation.kind}:${relation.source}->${relation.target}`,
    path: relation.path,
    name: relation.kind,
    detail: `${relation.source} -> ${relation.target}`,
    startLine: relation.line,
  };
}

export function entrypointRow(entrypoint: Entrypoint): QueryRow {
  return {
    kind: "entrypoint",
    key: `${entrypoint.kind}:${entrypoint.path}:${entrypoint.line}:${entrypoint.name}`,
    path: entrypoint.path,
    name: entrypoint.name,
    detail: `${entrypoint.kind} (${entrypoint.evidence})`,
    startLine: entrypoint.line,
  };
}

export function byKey(a: QueryRow, b: QueryRow): number {
  const left = a.distance ?? 0;
  const right = b.distance ?? 0;
  if (left !== right) return left - right;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
