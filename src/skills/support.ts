import { hashValue } from "../core/hash.js";
import { type TaskRef, taskRefKey } from "../core/identity.js";
import type { Task } from "../workflow/artifacts/tasks.js";
import type { ProductSlice } from "../workflow/product/model.js";
import { briefPath, type ProductRecord, readProductRecord } from "../workflow/product/store.js";
import { productContractDigest } from "../workflow/product/subject.js";
import type { WorkspaceState } from "../workflow/state.js";
import type { SkillRecord, SkillSupport } from "./schema.js";

export interface Support {
  /** Local task ids resolved unambiguously to closed work. */
  readonly closed: string[];
  readonly lost: string[];
  readonly snapshots: SkillSupport[];
}

interface TaskCandidate {
  readonly kind: "legacy";
  readonly feature: string;
  readonly task: Task;
  readonly draft: boolean;
}

interface ProductCandidate {
  readonly kind: "product";
  readonly feature: string;
  readonly slice: ProductSlice;
  readonly record: ProductRecord;
  readonly closure: ProductRecord["state"]["sliceHistory"][number];
  readonly evidence: ProductEvidence;
}

type SupportCandidate = TaskCandidate | ProductCandidate;
export type SupportKind = "any" | "legacy" | "product";
interface ProductEvidence {
  readonly verificationHash?: string;
  readonly reviewHash?: string;
}

/** Unqualified legacy ids resolve only when exactly one feature contains the id. */
export async function supportFor(
  state: WorkspaceState,
  feature: string | undefined,
  taskIds: readonly string[],
  kind: SupportKind = "any",
): Promise<Support> {
  const result: Support = { closed: [], lost: [], snapshots: [] };
  const listed = feature
    ? { ok: true as const, value: [feature] }
    : await state.store.listFeatures();
  if (!listed.ok) return { ...result, lost: [...new Set(taskIds)] };
  const wanted = new Set(taskIds);
  const tasks = await taskCandidates(state, listed.value, wanted, kind);
  if (!tasks) return { ...result, lost: [...wanted] };
  for (const id of wanted) {
    const matches = tasks.get(id) ?? [];
    const match = matches[0];
    if (matches.length !== 1 || !match || !isClosed(match)) {
      result.lost.push(id);
      continue;
    }
    result.closed.push(id);
    result.snapshots.push(await snapshotSupport(state, match));
  }
  return result;
}

async function taskCandidates(
  state: WorkspaceState,
  features: readonly string[],
  wanted: ReadonlySet<string>,
  kind: SupportKind,
): Promise<Map<string, SupportCandidate[]> | undefined> {
  const tasks = new Map<string, SupportCandidate[]>();
  for (const feature of features) {
    const productExists = await state.files.exists(briefPath(state, feature));
    if (!productExists.ok) return undefined;
    // A product brief owns the feature's current task semantics. Do not let a
    // stale migrated tasks.json make the same slice id ambiguous or supported.
    if (kind !== "product" && !productExists.value) {
      const legacy = await legacyCandidates(state, feature, wanted);
      if (!legacy.ok) return undefined;
      mergeCandidates(tasks, legacy.value);
    }

    if (kind !== "legacy") {
      const product = await productCandidates(state, feature, wanted);
      if (!product.ok) return undefined;
      mergeCandidates(tasks, product.value);
    }
  }
  return tasks;
}

async function legacyCandidates(
  state: WorkspaceState,
  feature: string,
  wanted: ReadonlySet<string>,
): Promise<{ ok: true; value: TaskCandidate[] } | { ok: false }> {
  const graph = await state.store.readTasksIfExists(feature);
  // Unreadable or draft sources must not make a citation elsewhere appear unique.
  if (!graph.ok) return { ok: false };
  if (!graph.value) return { ok: true, value: [] };
  const draft = graph.value.draft;
  return {
    ok: true,
    value: graph.value.tasks
      .filter((task) => wanted.has(task.id))
      .map((task) => ({ kind: "legacy" as const, feature, task, draft })),
  };
}

function mergeCandidates(
  target: Map<string, SupportCandidate[]>,
  candidates: readonly SupportCandidate[],
): void {
  for (const candidate of candidates) {
    const id = candidate.kind === "legacy" ? candidate.task.id : candidate.slice.id;
    const matches = target.get(id) ?? [];
    matches.push(candidate);
    target.set(id, matches);
  }
}

async function productCandidates(
  state: WorkspaceState,
  feature: string,
  wanted: ReadonlySet<string>,
): Promise<{ ok: true; value: ProductCandidate[] } | { ok: false }> {
  const exists = await state.files.exists(briefPath(state, feature));
  if (!exists.ok) return { ok: false };
  if (!exists.value) return { ok: true, value: [] };

  const record = await readProductRecord(state, { feature });
  if (!record.ok) return { ok: false };

  const candidates: ProductCandidate[] = [];
  for (const slice of record.value.brief.slices) {
    if (!wanted.has(slice.id)) continue;
    const closure = latestProductClosure(record.value, slice.id);
    const stored = record.value.state.slices[slice.id];
    // `legacy-closed` is historical migration state, not current product support.
    if (stored?.status !== "closed" || !closure) continue;
    const contractDigest = productContractDigest(record.value.brief, slice);
    if (stored.contractDigest !== contractDigest) continue;
    const evidence = productEvidence(record.value, slice, contractDigest, closure);
    if (!evidence) continue;
    // The closure ledger is slice-scoped. Later slices may legitimately change
    // the repository-wide subject digest without reopening this slice.
    candidates.push({ kind: "product", feature, slice, record: record.value, closure, evidence });
  }
  return { ok: true, value: candidates };
}

function productEvidence(
  record: ProductRecord,
  slice: ProductSlice,
  contractDigest: string,
  closure: ProductRecord["state"]["sliceHistory"][number],
): ProductEvidence | undefined {
  const requiredChecks = new Set(slice.checks);
  const executions = record.state.executions.filter(
    (entry) =>
      entry.task === slice.id &&
      entry.status === "passed" &&
      entry.contractDigest === contractDigest &&
      entry.subjectDigest === closure.subjectDigest &&
      entry.createdAt <= closure.createdAt &&
      requiredChecks.has(entry.check),
  );
  if (
    requiredChecks.size > 0 &&
    [...requiredChecks].some((check) => !executions.some((entry) => entry.check === check))
  )
    return undefined;

  const reviews = record.state.reviews.filter(
    (review) =>
      review.task === slice.id &&
      review.contractDigest === contractDigest &&
      review.subjectDigest === closure.subjectDigest &&
      review.createdAt <= closure.createdAt &&
      review.assessments.length > 0 &&
      review.assessments.every((assessment) => assessment.status === "satisfied"),
  );
  if (requiredChecks.size > 0) {
    return {
      verificationHash: hashValue(executions),
      ...(reviews.length > 0 ? { reviewHash: hashValue(reviews) } : {}),
    };
  }
  return reviews.length > 0 ? { reviewHash: hashValue(reviews) } : undefined;
}

function latestProductClosure(
  record: ProductRecord,
  task: string,
): ProductRecord["state"]["sliceHistory"][number] | undefined {
  return [...record.state.sliceHistory]
    .reverse()
    .find((entry) => entry.task === task && entry.to === "closed");
}

function isClosed(candidate: SupportCandidate): boolean {
  return candidate.kind === "legacy"
    ? !candidate.draft && candidate.task.status === "done"
    : candidate.record.state.slices[candidate.slice.id]?.status === "closed";
}

export async function supportForRefs(
  state: WorkspaceState,
  refs: readonly TaskRef[],
  kind: SupportKind = "any",
): Promise<Support> {
  const grouped = new Map<string, Set<string>>();
  for (const ref of refs) {
    const tasks = grouped.get(ref.feature) ?? new Set<string>();
    tasks.add(ref.task);
    grouped.set(ref.feature, tasks);
  }
  const result: Support = { closed: [], lost: [], snapshots: [] };
  for (const [feature, tasks] of grouped) {
    const support = await supportFor(state, feature, [...tasks], kind);
    result.closed.push(...support.closed.map((task) => `${feature}/${task}`));
    result.lost.push(...support.lost.map((task) => `${feature}/${task}`));
    result.snapshots.push(...support.snapshots);
  }
  return result;
}

async function snapshotSupport(
  state: WorkspaceState,
  candidate: SupportCandidate,
): Promise<SkillSupport> {
  if (candidate.kind === "product") {
    return {
      feature: candidate.feature,
      task: candidate.slice.id,
      taskHash: hashValue({
        kind: "product-slice-support",
        feature: candidate.feature,
        slice: candidate.slice,
        contractDigest: candidate.record.state.slices[candidate.slice.id]?.contractDigest,
        closure: candidate.closure,
        evidence: candidate.evidence,
      }),
      ...candidate.evidence,
    };
  }

  const { feature, task } = candidate;
  const verification = await state.store.readVerification(feature, task.id);
  const review = await state.store.readReview(feature, task.id);
  return {
    feature,
    task: task.id,
    taskHash: hashValue(task),
    ...(verification.ok && verification.value?.task === task.id && verification.value.passed
      ? { verificationHash: hashValue(verification.value) }
      : {}),
    ...(review.ok && review.value?.task === task.id && review.value.passed
      ? { reviewHash: hashValue(review.value) }
      : {}),
  };
}

/** Every cited source must still be the source reviewed at proposal time. */
export async function currentSupport(state: WorkspaceState, skill: SkillRecord): Promise<Support> {
  if (skill.support === undefined) return supportFor(state, skill.feature, skill.derivedFrom);
  const result: Support = { closed: [], lost: [], snapshots: [] };
  const seen = new Set<string>();
  for (const source of skill.support) {
    const key = `${source.feature}/${source.task}`;
    if (seen.has(taskRefKey(source))) continue;
    seen.add(taskRefKey(source));
    const current = await supportForRefs(state, [source]);
    const snapshot = current.snapshots.find(
      (candidate) => candidate.feature === source.feature && candidate.task === source.task,
    );
    if (
      !current.closed.includes(key) ||
      !snapshot ||
      snapshot.taskHash !== source.taskHash ||
      (source.verificationHash && snapshot.verificationHash !== source.verificationHash) ||
      (source.reviewHash && snapshot.reviewHash !== source.reviewHash)
    ) {
      result.lost.push(key);
      continue;
    }
    result.closed.push(key);
    result.snapshots.push(snapshot);
  }
  return result;
}
