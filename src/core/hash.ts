import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace. Two structurally equal values always produce the same string, so
 * hashes over artifacts are stable across machines and runs.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(input: string | Uint8Array): string {
  const hash = createHash("sha256");
  return (typeof input === "string" ? hash.update(input, "utf8") : hash.update(input)).digest(
    "hex",
  );
}

/** Stable hash of any JSON-serializable value. */
export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Short, human-comparable form of a hash for display. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareCodeUnits)) {
    const entry = source[key];
    if (entry !== undefined) sorted[key] = canonicalize(entry);
  }
  return sorted;
}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
