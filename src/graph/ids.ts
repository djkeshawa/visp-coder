import type { EntityKind } from "./types.js";

/**
 * Entity ids are readable and, deliberately, independent of line numbers: an
 * edit that moves a function must not invalidate every relation pointing at it.
 */

export function fileEntityId(path: string): string {
  return `${path}#file`;
}

export function entityId(path: string, kind: EntityKind, name: string): string {
  return `${path}#${kind}:${name}`;
}

/** Disambiguates same-named siblings within one file, deterministically by order. */
export class EntityIdAllocator {
  private readonly used = new Map<string, number>();

  allocate(path: string, kind: EntityKind, name: string): string {
    const base = entityId(path, kind, name);
    const seen = this.used.get(base) ?? 0;
    this.used.set(base, seen + 1);
    return seen === 0 ? base : `${base}~${seen}`;
  }
}

export function pathOfEntityId(id: string): string {
  const hash = id.lastIndexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}
