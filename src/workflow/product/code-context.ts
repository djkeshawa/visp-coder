import { sha256 } from "../../core/hash.js";
import { matchesAny } from "../../core/patterns.js";
import { isApplicationSource } from "../../graph/coverage-notes.js";
import { isIndexableProjectPath } from "../../graph/paths.js";
import type { WorkspaceState } from "../state.js";
import { productBehaviorProbes } from "./behavior-probes.js";
import { reviewExcerpt } from "./review-excerpts.js";
import type { ProductRecord } from "./store.js";
import { productSourceSnapshot } from "./subject.js";

export async function reviewCodeSources(
  workspace: WorkspaceState,
  record: ProductRecord,
  sourceSnapshot?: Record<string, string>,
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
  const scope = record.brief.slices.flatMap((slice) => slice.scope.allowed);
  const application = Object.keys(snapshot.value).filter(
    (path) =>
      (isApplicationSource(path) || /\.(?:css|scss|sass|less)$/i.test(path)) &&
      matchesAny(path, scope),
  );
  const checkFiles = record.brief.checks.flatMap((check) => check.files);
  const checks = Object.keys(snapshot.value).filter(
    (path) =>
      matchesAny(path, checkFiles) &&
      (isIndexableProjectPath(path) ||
        (/\.(md|mdx|txt|rst|adoc)$/i.test(path) &&
          !/^\.(visp|agents|claude|codex|cursor)\//.test(path))),
  );
  // Interleave owners and verifiers so long application lists do not hide weak assertions or indirect helpers.
  const paths = [
    ...new Set(
      application
        .flatMap((path, index) => [path, ...(checks[index] ? [checks[index]] : [])])
        .concat(checks),
    ),
  ];
  const findings = record.state.reviews
    .slice(-3)
    .flatMap((review) => review.feedback?.findings.map((finding) => finding.problem) ?? [])
    .join(" ");
  const question = [
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
  const sources = [];
  let remaining = 32000;
  for (const path of paths.slice(0, 8)) {
    const read = await workspace.files.readTextIfExists(path);
    if (!read.ok || read.value === undefined || read.value.includes("\0")) {
      sources.push({
        id: `CODE-${sha256(path).slice(0, 16)}`,
        kind: "implementation-file" as const,
        reference: path,
        sha256: snapshot.value[path] ?? "",
        available: false,
        excerpt: read.ok
          ? "Source is missing or binary; inspect with an appropriate reader"
          : read.error.message,
        truncated: true,
      });
      continue;
    }
    const digest = sha256(read.value);
    const selection = await reviewExcerpt(path, read.value, question, Math.min(6000, remaining));
    remaining -= selection.excerpt.length;
    sources.push({
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
    });
  }
  if (paths.length > 8)
    sources.push({
      id: "CODE-OMITTED",
      kind: "implementation-file" as const,
      reference: "Additional implementation and check files",
      sha256: "",
      available: false,
      excerpt: `${paths.length - 8} additional files require direct inspection before judging them. First omitted files: ${paths.slice(8, 14).join(", ")}`,
      truncated: true,
    });
  return sources;
}
