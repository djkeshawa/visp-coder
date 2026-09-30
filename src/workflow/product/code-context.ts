import { sha256 } from "../../core/hash.js";
import { matchesAny } from "../../core/patterns.js";
import { privatePath } from "../../core/redaction.js";
import { ok } from "../../core/result.js";
import { isApplicationSource } from "../../graph/coverage-notes.js";
import { isIndexableProjectPath } from "../../graph/paths.js";
import type { WorkspaceState } from "../state.js";
import { pinnedAcceptanceChecks } from "./acceptance-checks.js";
import { productBehaviorProbes } from "./behavior-probes.js";
import { isBrowserCheckCommand } from "./check-command.js";
import {
  latestExecutionsByOwner,
  type ProductCheck,
  type ProductExecution,
  type ProductSlice,
} from "./model.js";
import { reviewCheckPaths, reviewCheckResult } from "./review-check-context.js";
import { reviewExcerpt } from "./review-excerpts.js";
import { readProductAuthorization } from "./scopes.js";
import type { ProductSource } from "./sources.js";
import type { ProductRecord } from "./store.js";
import { productSourceChanges, productSourceDigest, productSourceSnapshot } from "./subject.js";

/** The authorization baseline identifies the current slice's changed deliverables. */
export async function reviewChangedPaths(
  workspace: WorkspaceState,
  record: ProductRecord,
  snapshot: Record<string, string>,
  slice?: ProductSlice,
) {
  const authorization = await readProductAuthorization(workspace, record);
  if (!authorization.ok) return authorization;
  if (!authorization.value || (slice && authorization.value.task !== slice.id))
    return ok(new Set<string>());
  const changes = await productSourceChanges(workspace, authorization.value.baseline, snapshot);
  return changes.ok ? ok(new Set(changes.value)) : changes;
}

export async function reviewCodeSources(
  workspace: WorkspaceState,
  record: ProductRecord,
  sourceSnapshot?: Record<string, string>,
  subject?: string,
  slice?: ProductSlice,
  changedPaths: ReadonlySet<string> = new Set(),
) {
  const snapshot =
    sourceSnapshot === undefined
      ? await productSourceSnapshot(workspace, record.brief)
      : ({ ok: true, value: sourceSnapshot } as const);
  if (!snapshot.ok)
    return [
      {
        id: "CODE-UNAVAILABLE",
        kind: "implementation-file" as const,
        reference: "Current implementation",
        sha256: "",
        available: false,
        excerpt: snapshot.error.message,
      },
    ];
  const { candidates, declarations } = await sourceCandidates(
    workspace,
    record,
    snapshot.value,
    subject,
    slice,
    changedPaths,
  );
  const question = reviewQuestion(record);
  const sources: ProductSource[] = [];
  let remaining = 31000; // Reserve space within the existing 32k budget for cutoff disclosures.
  const selected = candidates.slice(0, 8);
  for (const [index, candidate] of selected.entries()) {
    const limit = Math.min(6000, Math.floor(remaining / (selected.length - index)));
    const source = await readReviewSource(
      workspace,
      candidate,
      snapshot.value,
      declarations,
      question,
      limit,
    );
    remaining -= source.excerpt.length;
    sources.push(source);
  }
  if (candidates.length > selected.length) {
    const omitted = candidates.slice(selected.length);
    sources.push({
      id: "CODE-OMITTED",
      kind: "implementation-file",
      reference: "Additional review evidence",
      sha256: "",
      available: false,
      excerpt:
        `Review packet cutoff: ${[...new Set(candidates.map((entry) => entry.category))].map((category) => `${omitted.filter((candidate) => candidate.category === category).length} ${category}`).join(", ")} entries omitted. Inspect before judging them. First omitted: ${omitted
          .slice(0, 8)
          .map((entry) => entry.path ?? entry.execution?.id)
          .join(", ")}`.slice(0, 1000),
    });
  }
  return sources;
}

function isReviewablePath(path: string) {
  return (
    !privatePath(path) &&
    (isIndexableProjectPath(path) ||
      (/\.(md|mdx|txt|rst|adoc|json|ya?ml)$/i.test(path) &&
        !/^\.(visp|agents|claude|codex|cursor)\//.test(path)))
  );
}

/** A named file or a requested class of documents; scope keeps unrelated project docs out. */
function requestedDocument(path: string, request: string): number {
  if (!/\.(md|mdx|txt|rst|adoc|json|ya?ml)$/i.test(path)) return 0;
  const lower = request.toLowerCase();
  const name = path.split("/").at(-1)?.toLowerCase() ?? path;
  const named: string[] = lower.match(/[\w./-]+\.(?:md|mdx|txt|rst|adoc|json|ya?ml)\b/g) ?? [];
  if (named.includes(path.toLowerCase())) return 3;
  const generic = request.replace(/[\w./-]+\.(?:md|mdx|txt|rst|adoc|json|ya?ml)\b/gi, "");
  if (named.includes(name)) return 2;
  if (/^readme(?:\.|$)/i.test(name) && /\breadme\b/i.test(generic)) return 1;
  return Number(
    (/\b(?:docs|documentation)\b/i.test(generic) && /^(?:docs?|documentation)\//i.test(path)) ||
      (/\bcontract\b/i.test(generic) && /contract/i.test(name)),
  );
}

interface SourceCandidate {
  path?: string;
  execution?: ProductExecution;
  category: string;
  sourceUnresolved?: boolean;
}

async function sourceCandidates(
  workspace: WorkspaceState,
  record: ProductRecord,
  snapshot: Record<string, string>,
  subject?: string,
  slice?: ProductSlice,
  changedPaths: ReadonlySet<string> = new Set(),
) {
  const scope = (slice ? [slice] : record.brief.slices).flatMap((entry) => entry.scope.allowed);
  const application = Object.keys(snapshot).filter(
    (path) =>
      (isApplicationSource(path) || /\.(?:css|scss|sass|less)$/i.test(path)) &&
      matchesAny(path, scope),
  );
  const { applicableExecutions } = await import("./assessment.js");
  const digest =
    subject === undefined
      ? await productSourceDigest(workspace, record.brief, snapshot)
      : { ok: true as const, value: subject };
  const executions = digest.ok
    ? latestExecutionsByOwner(applicableExecutions(record, digest.value, slice))
    : [];
  const declarations = [...record.brief.checks, ...pinnedAcceptanceChecks(record.brief)];
  const executedChecks = declarations.filter((check) =>
    executions.some((execution) => execution.check === check.id),
  );
  const checkPaths = await Promise.all(
    executedChecks.map(async (check) => ({
      check,
      paths: await reviewCheckPaths(workspace, [check], snapshot),
    })),
  );
  const unresolvedChecks = new Set(
    checkPaths
      .filter(({ check, paths }) => !paths.length && !isBrowserCheckCommand(check.command))
      .map(({ check }) => check.id),
  );
  const checks = checkPaths.flatMap(({ paths }) => paths);
  // Preserve declared check inputs in read-only packets before a check has run as well.
  checks.push(
    ...Object.keys(snapshot).filter(
      (path) =>
        matchesAny(
          path,
          record.brief.checks.flatMap((check) => check.files),
        ) && isReviewablePath(path),
    ),
  );
  const documents = Object.keys(snapshot)
    .filter(
      (path) =>
        matchesAny(path, scope) &&
        isReviewablePath(path) &&
        requestedDocument(path, record.brief.originalRequest),
    )
    .sort(
      (a, b) =>
        requestedDocument(b, record.brief.originalRequest) -
          requestedDocument(a, record.brief.originalRequest) ||
        Number(changedPaths.has(b)) - Number(changedPaths.has(a)),
    );
  const classes = [
    {
      name: "executed check results",
      entries: executions.map((execution) => ({
        execution,
        sourceUnresolved: unresolvedChecks.has(execution.check),
      })),
    },
    { name: "verifier/check source", entries: [...new Set(checks)].map((path) => ({ path })) },
    { name: "requested deliverables", entries: documents.map((path) => ({ path })) },
    { name: "implementation", entries: application.map((path) => ({ path })) },
  ];
  const candidates: SourceCandidate[] = [];
  const seen = new Set<string>();
  for (let index = 0; classes.some((entry) => entry.entries.length > index); index++)
    for (const category of classes) {
      const entry = category.entries[index];
      if (!entry) continue;
      const key = "path" in entry ? entry.path : entry.execution.id;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...entry, category: category.name });
    }
  return { candidates, declarations };
}

function reviewQuestion(record: ProductRecord) {
  const findings = record.state.reviews
    .slice(-3)
    .flatMap((review) => review.feedback?.findings.map((finding) => finding.problem) ?? [])
    .join(" ");
  return [
    findings,
    ...record.state.reviews
      .slice(-3)
      .flatMap((review) =>
        (review.feedback?.probes ?? [])
          .filter((probe) => probe.status !== "satisfied")
          .flatMap((probe) => [probe.expected, probe.exercise, probe.observed]),
      ),
    ...productBehaviorProbes(record).probes.map((probe) => probe.question),
    record.brief.originalRequest,
    ...record.brief.outcomes.map((outcome) => outcome.statement),
    ...record.brief.examples.flatMap((example) => [
      example.title,
      example.when,
      ...example.expected,
    ]),
  ].join(" ");
}

async function readReviewSource(
  workspace: WorkspaceState,
  candidate: SourceCandidate,
  snapshot: Record<string, string>,
  declarations: ProductCheck[],
  question: string,
  limit: number,
): Promise<ProductSource> {
  if (candidate.execution) {
    const execution = candidate.execution;
    const text = reviewCheckResult(
      execution,
      declarations.find((check) => check.id === execution.check),
    );
    const gap = candidate.sourceUnresolved
      ? "Evidence gap: executed verifier/check source is unresolved or unavailable. Inspect the runner's selected assertion sources before judging coverage.\n"
      : "";
    const selection = await reviewExcerpt("check-results.txt", text, question, limit - gap.length);
    return {
      id: `CHECK-${execution.id}`,
      kind: "executed-check",
      reference: `Executed ${execution.check} at ${execution.subjectDigest}`,
      sha256: sha256(text),
      available: true,
      excerpt: gap + selection.excerpt,
      omittedRegions: selection.omitted,
    };
  }
  const path = candidate.path as string;
  const read = await workspace.files.readTextIfExists(path);
  if (!read.ok || read.value === undefined || read.value.includes("\0")) {
    return {
      id: `CODE-${sha256(path).slice(0, 16)}`,
      kind: "implementation-file" as const,
      reference: path,
      sha256: snapshot[path] ?? "",
      available: false,
      excerpt: (read.ok
        ? "Source is missing or binary; inspect with an appropriate reader"
        : read.error.message
      ).slice(0, limit),
      truncated: true,
    };
  }
  const digest = sha256(read.value);
  const selection = await reviewExcerpt(path, read.value, question, limit);
  return {
    id: `CODE-${sha256(`${path}:${digest}`).slice(0, 16)}`,
    kind: "implementation-file" as const,
    reference: path,
    sha256: digest,
    available: true,
    excerpt: selection.excerpt,
    truncated: selection.omitted.length > 0,
    omittedRegions: selection.omitted,
    ...(selection.omitted.length
      ? { nextRead: `Read ${path} at the omitted line ranges before judging those behaviors` }
      : {}),
  };
}
