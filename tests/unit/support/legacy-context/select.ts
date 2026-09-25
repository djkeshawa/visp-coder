/** Historical test-fixture builder; never used by the product workflow. */
import { matchesAny, matchesPattern } from "../../../../src/core/patterns.js";
import type { SelectionReason } from "../../../../src/workflow/artifacts/context.js";
import type { Task } from "../../../../src/workflow/artifacts/tasks.js";
import { fusedScores } from "./ranking.js";

/**
 * Chooses which files belong in a task's context pack. Selection is
 * deterministic and explains itself: every file carries the reason it was
 * chosen, so an over-broad pack is visible rather than merely large.
 */

export interface Candidate {
  readonly path: string;
  readonly reason: SelectionReason;
  /** Lower sorts first. Derived from the reason, not from a learned score. */
  readonly rank: number;
  /** Orders candidates within a rank: hop distance for neighbours, zero otherwise. */
  readonly order: number;
}

const RANK: Record<SelectionReason, number> = {
  "expected-file": 0,
  // The failure literally named it, which is stronger than being merely allowed.
  "named-in-failure": 1,
  "dependency-output": 2,
  "test-of-allowed-file": 3,
  "structural-neighbour": 4,
  "task-term-match": 5,
  entrypoint: 6,
  "project-config": 7,
  // Editing permission alone says nothing about relevance to this task.
  "allowed-file": 8,
  // `selectFiles` never produces this: a skill is chosen by its trigger, not by
  // being a repository path. Ranked last so the table stays total.
  skill: 9,
};

export interface SelectionInput {
  readonly ranking?: "priority" | "fused";
  readonly task: Task;
  /** Every repository file path, from the graph or a plain walk. */
  readonly repositoryFiles: readonly string[];
  /** Files the graph reports as structurally near the task's own files. */
  readonly neighbours?: readonly { path: string; hops: number }[];
  /**
   * What the tasks this one depends on produced. A task creating new files has
   * no structural neighbours yet, but it almost always needs to call what came
   * before it.
   */
  readonly dependencyFiles?: readonly string[];
  /** Test files the graph maps to the task's files. */
  readonly tests?: readonly string[];
  /** Files a failed verification or review named in its output. */
  readonly failureFiles?: readonly string[];
  readonly entrypoints?: readonly string[];
  /** Only callers asking for a preview should cap selection. Compilation budgets delivery. */
  readonly maxFiles?: number;
}

export function selectFiles(input: SelectionInput): Candidate[] {
  const candidates = new Map<string, Candidate>();
  const signals: Candidate[] = [];
  const record = (candidate: Candidate): void => {
    if (input.ranking === "fused") signals.push(candidate);
    putCandidate(candidates, candidate);
  };

  const add = (path: string, reason: SelectionReason, order = 0): void => {
    record({ path, reason, rank: RANK[reason], order });
  };

  for (const candidate of repositoryCandidates(input)) record(candidate);
  for (const path of expandPatterns(input.task.expectedFiles, input.repositoryFiles)) {
    add(path, "expected-file");
  }

  for (const path of input.failureFiles ?? []) add(path, "named-in-failure");
  for (const path of expandPatterns(input.dependencyFiles ?? [], input.repositoryFiles)) {
    add(path, "dependency-output");
  }
  for (const path of expandPatterns(input.tests ?? [], input.repositoryFiles)) {
    add(path, "test-of-allowed-file");
  }
  // A direct importer says more about the task than a two-hop acquaintance, so
  // the alphabet only breaks ties within a hop.
  for (const file of input.neighbours ?? []) add(file.path, "structural-neighbour", file.hops);
  for (const path of input.entrypoints ?? []) add(path, "entrypoint");

  const scores = input.ranking === "fused" ? fusedScores(signals) : undefined;
  return [...candidates.values()]
    .sort((a, b) => {
      if (scores && !isEssentialContext(a.reason) && !isEssentialContext(b.reason)) {
        const difference = (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0);
        if (difference !== 0) return difference;
      }
      return a.rank - b.rank || a.order - b.order || compare(a.path, b.path);
    })
    .slice(0, input.maxFiles ?? Number.POSITIVE_INFINITY);
}

function repositoryCandidates(input: SelectionInput): Candidate[] {
  const terms = taskTerms(`${input.task.title} ${input.task.description}`);
  return input.repositoryFiles.flatMap((path): Candidate[] => {
    if (matchesAny(path, input.task.expectedFiles)) {
      return [{ path, reason: "expected-file", rank: RANK["expected-file"], order: 0 }];
    }
    const score = [...taskTerms(path)].filter((term) => terms.has(term)).length;
    if (score === 0 && !matchesAny(path, input.task.allowedFiles)) return [];
    const reason = score > 0 ? "task-term-match" : "allowed-file";
    return [{ path, reason, rank: RANK[reason], order: -score }];
  });
}

function putCandidate(candidates: Map<string, Candidate>, candidate: Candidate): void {
  const existing = candidates.get(candidate.path);
  if (
    existing &&
    (existing.rank < candidate.rank ||
      (existing.rank === candidate.rank && existing.order <= candidate.order))
  )
    return;
  candidates.set(candidate.path, candidate);
}

const GENERAL_TASK_TERMS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "add",
  "change",
  "implement",
  "update",
  "fix",
  "repair",
  "file",
  "files",
  "src",
  "test",
  "tests",
  "use",
  "into",
]);

function taskTerms(text: string): Set<string> {
  return new Set(
    (
      text
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[a-z][a-z0-9]{2,}/g) ?? []
    ).filter((term) => !GENERAL_TASK_TERMS.has(term)),
  );
}

/** Keep unmatched declarations so the compiler reports the missing input. */
function expandPatterns(patterns: readonly string[], files: readonly string[]): string[] {
  const exact = new Set(files);
  return patterns.flatMap((pattern) => {
    if (exact.has(pattern)) return [pattern];
    const matched = files.filter((path) => matchesPattern(path, pattern));
    return matched.length > 0 ? matched : [pattern];
  });
}

export function isEssentialContext(reason: SelectionReason): boolean {
  return RANK[reason] <= RANK["test-of-allowed-file"];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
