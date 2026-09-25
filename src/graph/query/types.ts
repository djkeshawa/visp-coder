import type { EntrypointKind, LanguageCoverage, UnknownKind, UnknownRecord } from "../types.js";

export const QUERY_OPERATIONS = [
  "describe",
  "search",
  "entity",
  "neighbors",
  "callers",
  "callees",
  "tracePath",
  "testsFor",
  "impact",
  "unknowns",
] as const;

export type QueryOperation = (typeof QUERY_OPERATIONS)[number];

export interface QueryBudget {
  readonly depth: number;
  readonly results: number;
  /** Traversal work limits, independent of response size. */
  readonly nodes?: number;
  readonly edges?: number;
}

export type QueryRowKind = "entity" | "relation" | "file" | "entrypoint";

/** Flat rows so every operation renders and hashes the same way. */
export interface QueryRow {
  readonly kind: QueryRowKind;
  /** Stable identity used for ordering; identical inputs give identical output. */
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly detail: string;
  readonly distance?: number;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface QueryWork {
  readonly visitedNodes: number;
  readonly examinedEdges: number;
  readonly truncated: boolean;
}

export interface QueryReceipt {
  readonly work?: QueryWork;
  readonly operation: QueryOperation;
  readonly budget: QueryBudget;
  readonly truncated: boolean;
  readonly resultHash: string;
}

export interface RepoSummary {
  readonly snapshotId: string;
  readonly fingerprint: string;
  readonly files: number;
  readonly entities: number;
  readonly relations: number;
  readonly unknowns: number;
  readonly entrypoints: number;
  readonly languageCoverage: LanguageCoverage[];
  readonly entrypointCounts: { readonly kind: EntrypointKind; readonly count: number }[];
}

export interface QueryEnvelope {
  readonly operation: QueryOperation;
  readonly rows: QueryRow[];
  /**
   * Unknowns survive truncation before rows do, so a budget-starved answer
   * still shows what the graph does not know.
   */
  readonly unknowns: UnknownRecord[];
  readonly receipt: QueryReceipt;
  readonly notes: string[];
  readonly summary?: RepoSummary;
}

/** An operation's answer before the budget is applied. */
export interface QueryDraft {
  readonly work?: QueryWork;
  readonly rows: QueryRow[];
  readonly unknowns: UnknownRecord[];
  readonly notes: string[];
  readonly summary?: RepoSummary;
}

export interface QueryArgs {
  readonly name?: string;
  readonly entity?: string;
  readonly path?: string;
  readonly from?: string;
  readonly to?: string;
  readonly kind?: UnknownKind;
}
