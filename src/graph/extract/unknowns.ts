import { compareCodeUnits } from "../../core/hash.js";
import type { UnknownKind, UnknownRecord } from "../types.js";

/**
 * Every gap the extractor meets is written down here. Deduplication is by the
 * whole record, so repetition never inflates a count and nothing is dropped to
 * keep a result looking tidy.
 */
export class UnknownCollector {
  private readonly records = new Map<string, UnknownRecord>();

  record(kind: UnknownKind, path: string, detail: string): void {
    const trimmed = detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
    const record: UnknownRecord = { kind, path, detail: trimmed };
    this.records.set(`${kind}\u0000${path}\u0000${trimmed}`, record);
  }

  addAll(records: Iterable<UnknownRecord>): void {
    for (const record of records) this.record(record.kind, record.path, record.detail);
  }

  toArray(): UnknownRecord[] {
    return [...this.records.values()].sort(compareUnknowns);
  }
}

export function compareUnknowns(a: UnknownRecord, b: UnknownRecord): number {
  return (
    compareCodeUnits(a.path, b.path) ||
    compareCodeUnits(a.kind, b.kind) ||
    compareCodeUnits(a.detail, b.detail)
  );
}
