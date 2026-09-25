/** Historical context fixture builder; never imported by production entry points. */
import { FILE, PRODUCT_NAME } from "../../../src/core/constants.js";
import { vispError } from "../../../src/core/errors.js";
import { applyFileTransaction, withStateMutation } from "../../../src/core/file-transaction.js";
import { sha256 } from "../../../src/core/hash.js";
import { err, ok, type Result } from "../../../src/core/result.js";
import { recordActivity } from "../../../src/orchestrate/session.js";
import type { ApplicationFacts } from "../../../src/skills/applies.js";
import { reconcileLineage } from "../../../src/skills/lineage.js";
import { rankSkills } from "../../../src/skills/rank.js";
import type { SkillRecord } from "../../../src/skills/schema.js";
import { fingerprint, readIndex, readSkillBody, skillPath } from "../../../src/skills/store.js";
import { now } from "../../../src/workflow/artifacts/common.js";
import type {
  AttemptFeedback,
  ContextContract,
  ContextFile,
  ContextManifest,
  ContextPack,
} from "../../../src/workflow/artifacts/context.js";
import { findTask, type Task, type TaskGraph } from "../../../src/workflow/artifacts/tasks.js";
import { stableContextHash } from "../../../src/workflow/stages/context/digest.js";
import { updateStatus, type WorkspaceState } from "../../../src/workflow/state.js";
import { fitContextBudget } from "./legacy-context/budget.js";
import { readContextContract } from "./legacy-context/contract.js";
import { legacyContextDefaults } from "./legacy-context/defaults.js";
import { readCandidates, regionsOfSnippets } from "./legacy-context/delivery.js";
import { extractFailurePaths } from "./legacy-context/failure-paths.js";
import { estimateDeliveredFileTokens } from "./legacy-context/render.js";
import { type Candidate, selectFiles } from "./legacy-context/select.js";
import { extractSnippets } from "./legacy-context/snippets.js";
import { sourceHash } from "./legacy-context/source-hash.js";
import type { ContextOptions, ContextOutcome } from "./legacy-context/types.js";

export type {
  ContextOptions,
  ContextOutcome,
  GraphFacts,
} from "./legacy-context/types.js";

export async function buildContextPack(
  state: WorkspaceState,
  options: ContextOptions,
): Promise<Result<ContextOutcome>> {
  return withStateMutation(state.paths.root, () => buildLockedContextPack(state, options));
}

async function buildLockedContextPack(
  state: WorkspaceState,
  options: ContextOptions,
): Promise<Result<ContextOutcome>> {
  const resolved = await resolveContextTask(state, options);
  if (!resolved.ok) return resolved;

  const compiled = await compileContextPack(state, options, resolved.value);
  if (!compiled.ok) return compiled;

  const manifest = await buildManifest(
    state,
    options.feature,
    resolved.value.task.id,
    compiled.value.pack,
    options.graph?.snapshotId,
  );
  if (!manifest.ok) return manifest;

  const persisted = await persistContextPack(
    state,
    options,
    resolved.value.task.id,
    compiled.value,
    manifest.value,
  );
  if (!persisted.ok) return persisted;

  return ok({
    pack: compiled.value.pack,
    manifest: manifest.value,
    path: persisted.value,
    skippedSkills: compiled.value.skippedSkills,
  });
}

interface ResolvedContextTask {
  readonly graph: TaskGraph;
  readonly task: Task;
  readonly repositoryFiles: readonly string[];
}

interface CompiledContext {
  readonly pack: ContextPack;
  readonly feedback?: AttemptFeedback;
  readonly skippedSkills: readonly string[];
}

async function resolveContextTask(
  state: WorkspaceState,
  options: ContextOptions,
): Promise<Result<ResolvedContextTask>> {
  const graph = await state.store.readTasks(options.feature);
  if (!graph.ok) return graph;

  const task = findTask(graph.value, options.taskId);
  if (!task) {
    return err(
      vispError("TASK_NOT_FOUND", `${options.taskId} is not in the task graph`, {
        recovery: "visp status",
      }),
    );
  }
  return ok({
    graph: graph.value,
    task,
    repositoryFiles: options.graph?.repositoryFiles ?? options.repositoryFiles ?? [],
  });
}

async function compileContextPack(
  state: WorkspaceState,
  options: ContextOptions,
  resolved: ResolvedContextTask,
): Promise<Result<CompiledContext>> {
  const feedback = await readAttemptFeedback(
    state,
    options.feature,
    resolved.task.id,
    resolved.repositoryFiles,
  );
  if (!feedback.ok) return feedback;

  const contract = await readContextContract(state, options.feature, resolved.task);
  if (!contract.ok) return contract;
  const required = assembleContextPack(
    state,
    options,
    resolved.task,
    contract.value,
    feedback.value,
    [],
    [],
    [],
  );

  const candidates = contextCandidates(
    options,
    resolved,
    feedback.value,
    legacyContextDefaults.ranking,
  );
  const contents = await readCandidates(
    state,
    candidates,
    options.graph?.regionsByPath ?? {},
    Math.max(0, state.config.context.tokenBudget - required.estimatedTokens),
  );
  if (!contents.ok) return contents;

  const skills = await selectSkillFiles(state, contextSkillFacts(options, resolved.task));
  if (!skills.ok) return skills;

  return ok({
    pack: assembleContextPack(
      state,
      options,
      resolved.task,
      contract.value,
      feedback.value,
      contents.value.files,
      skills.value.files,
      contents.value.omitted,
      skills.value.skipped,
    ),
    ...(feedback.value ? { feedback: feedback.value } : {}),
    skippedSkills: skills.value.skipped,
  });
}

function contextCandidates(
  options: ContextOptions,
  resolved: ResolvedContextTask,
  feedback?: AttemptFeedback,
  ranking?: "priority" | "fused",
): Candidate[] {
  return selectFiles({
    ranking,
    task: resolved.task,
    repositoryFiles: resolved.repositoryFiles,
    dependencyFiles: dependencyOutputs(resolved.graph, resolved.task),
    tests: [...resolved.task.validationFiles, ...(options.graph?.tests ?? [])],
    ...(feedback ? { failureFiles: feedback.referencedFiles } : {}),
    ...(options.graph
      ? {
          neighbours: options.graph.neighbours,
          entrypoints: options.graph.entrypoints,
        }
      : {}),
  });
}

function contextSkillFacts(options: ContextOptions, task: Task): ApplicationFacts {
  return {
    // The stages this pack serves — not SELECTING_STAGES, which now also names
    // the drafting stages. Passing the whole list here made a spec-only skill
    // match every implementation pack, which is exactly the over-firing the
    // stage dimension exists to prevent.
    stages: PACK_STAGES,
    taskClass: task.taskClass,
    scopePaths: [...task.allowedFiles, ...task.expectedFiles],
    ...(options.graph
      ? { entrypointKinds: options.graph.entrypointKinds, languages: options.graph.languages }
      : {}),
  };
}

function assembleContextPack(
  state: WorkspaceState,
  options: ContextOptions,
  task: Task,
  contract: ContextContract,
  feedback: AttemptFeedback | undefined,
  files: readonly ContextFile[],
  skillFiles: readonly ContextFile[],
  omitted: ContextPack["omitted"],
  skillDiagnostics: readonly string[] = [],
): ContextPack {
  const budget = state.config.context.tokenBudget;
  const pack: ContextPack = {
    kind: "context",
    createdAt: now(),
    feature: options.feature,
    task: task.id,
    goal: task.title,
    contract,
    artifactRef: state.paths.relative(state.paths.contextFile(options.feature, task.id)),
    files: [...files, ...skillFiles],
    omitted,
    ...(skillDiagnostics.length ? { skillDiagnostics: [...skillDiagnostics] } : {}),
    entrypoints: [...(options.graph?.entrypoints ?? [])],
    unknowns: [...(options.graph?.unknowns ?? [])],
    ...(feedback ? { attemptFeedback: feedback } : {}),
    ...(options.staleIndex ? { staleIndex: options.staleIndex } : {}),
    estimatedTokens: 0,
    tokenBudget: budget,
    graphAvailable: options.graph !== undefined,
    graphDeferred: options.graphDeferred === true,
  };
  return fitContextBudget(pack, task, legacyContextDefaults.includeSnippets);
}

async function persistContextPack(
  state: WorkspaceState,
  options: ContextOptions,
  taskId: string,
  compiled: CompiledContext,
  manifest: ContextManifest,
): Promise<Result<string>> {
  const packPath = state.paths.contextFile(options.feature, taskId);
  const written = await applyFileTransaction(state.paths.root, "compile-context", [
    { kind: "write", path: packPath, content: `${JSON.stringify(compiled.pack, null, 2)}\n` },
    {
      kind: "write",
      path: state.paths.contextManifest(options.feature, taskId),
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ]);
  if (!written.ok) return written;

  const status = await updateStatus(state, {
    activeTask: taskId,
    stage: "context",
    lastCommand: `context ${taskId}`,
  });
  if (!status.ok) return status;

  // The trail used to record `done` and nothing else, which made "did the
  // agent ever rebuild context?" unanswerable for every finished run.
  await recordActivity(state, {
    command: "context",
    outcome: "ok",
    detail: compiled.feedback
      ? `${taskId} (answering a failed ${compiled.feedback.source})`
      : taskId,
  });
  return ok(packPath);
}

/** A context pack is compiled at `context` and read for the implementation. */
const PACK_STAGES: ApplicationFacts["stages"] = ["context", "implement"];

interface SelectedSkills {
  readonly files: ContextFile[];
  /** Skills that matched but could not be used, so their absence is explained. */
  readonly skipped: string[];
}

/**
 * The admitted skills whose triggers fire here, as ordinary context entries.
 *
 * They arrive the same way files do — with a reason, against the same budget —
 * because a pack that grows by a route of its own is a pack nobody can reason
 * about. They arrive *after* the files for the same reason: advice must never
 * displace the code the task is actually about.
 *
 * The cap counts what actually goes in rather than what was ranked, so a skill
 * that turns out to be unusable gives its slot back to the next match instead of
 * quietly shrinking the pack.
 */
async function selectSkillFiles(
  state: WorkspaceState,
  facts: ApplicationFacts,
): Promise<Result<SelectedSkills>> {
  const empty: SelectedSkills = { files: [], skipped: [] };
  if (!state.config.skills.enabled || state.config.skills.maxPerPack <= 0) return ok(empty);

  // A skill whose source work has gone still reads as `admitted` until someone
  // looks, and the pack is exactly the place that must not act on it. A failed
  // reconciliation leaves support unknown, so compilation cannot use that state.
  const lineage = await reconcileLineage(state);
  if (!lineage.ok) return lineage;

  const index = await readIndex(state);
  if (!index.ok) return index;

  const files: ContextFile[] = [];
  const skipped: string[] = [];

  for (const candidate of rankSkills({ skills: index.value.skills, facts })) {
    if (files.length >= state.config.skills.maxPerPack) break;

    const entry = await readSkillEntry(state, candidate.skill);
    if (!entry.ok) return entry;

    if (entry.value === undefined) {
      // Says only what was established — the file is not the one admitted —
      // rather than guessing between edited and gone. `skill diff` says which.
      skipped.push(
        `${candidate.skill.id} applies here, but its file is not the one that was admitted, ` +
          `so it was left out. Run: ${PRODUCT_NAME} skill diff ${candidate.skill.id}`,
      );
      continue;
    }

    files.push(entry.value);
  }

  return ok({ files, skipped });
}

/**
 * One skill as a context entry, or undefined when it is not the skill that was
 * admitted — the file is gone, or its text has moved on from what a person
 * signed off. Including it under that name would claim a review of this text
 * that never happened.
 */
async function readSkillEntry(
  state: WorkspaceState,
  skill: SkillRecord,
): Promise<Result<ContextFile | undefined>> {
  const body = await readSkillBody(state, skill.id);
  if (!body.ok) return body;
  if (body.value === undefined || fingerprint(body.value) !== skill.contentHash) {
    return ok(undefined);
  }

  const path = state.paths.relative(skillPath(state, skill.id));
  if (path === undefined) return ok(undefined);

  const { snippets, truncated } = extractSnippets(body.value, {
    cap: legacyContextDefaults.snippetCap,
    maxSnippets: state.config.context.maxSnippets,
    maxLines: legacyContextDefaults.maxSnippetLines,
  });

  const entry: ContextFile = {
    path,
    reason: "skill",
    hash: sha256(body.value),
    regions: regionsOfSnippets(snippets),
    snippets: legacyContextDefaults.includeSnippets ? snippets : [],
    estimatedTokens: 0,
    truncated,
  };
  return ok({
    ...entry,
    estimatedTokens: estimateDeliveredFileTokens(entry, legacyContextDefaults.includeSnippets),
  });
}

/** Per failing command, so one noisy command cannot spend the whole feedback. */
const FAILURE_OUTPUT_CAP = 2000;

/**
 * What the last failed attempt at this task said, if there was one. Only a
 * record written for *this* task counts — the store falls back to the
 * feature-wide file, and another task's failure must not brief this one.
 */
async function readAttemptFeedback(
  state: WorkspaceState,
  feature: string,
  taskId: string,
  repositoryFiles: readonly string[],
): Promise<Result<AttemptFeedback | undefined>> {
  const verification = await state.store.readVerification(feature, taskId);
  if (!verification.ok) return verification;
  const review = await state.store.readReview(feature, taskId);
  if (!review.ok) return review;

  const failed = [
    ...(isTaskFailure(verification.value, taskId) ? [verification.value] : []),
    ...(isTaskFailure(review.value, taskId) ? [review.value] : []),
  ].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  // Verify and review answer different questions; the newest is the one the
  // next attempt has to fix.
  const record = failed.at(-1);
  if (!record) return ok(undefined);

  const failingCommands =
    record.kind === "verification"
      ? record.commands
          .filter((entry) => !entry.passed)
          .map((entry) => ({
            command: entry.command,
            exitCode: entry.exitCode,
            output: (entry.output ?? "").slice(0, FAILURE_OUTPUT_CAP),
          }))
      : [];

  const unresolvedFindings = record.findings.filter((finding) => finding.severity !== "info");

  const recordFiles = record.kind === "verification" ? record.changedFiles : record.reviewedFiles;
  const known = [...new Set([...recordFiles, ...repositoryFiles])];
  const referencedFiles = [
    ...new Set([
      ...extractFailurePaths(
        failingCommands.map((entry) => entry.output),
        known,
      ),
      // A finding that names a path has already done the resolution.
      ...unresolvedFindings.flatMap((finding) => (finding.path ? [finding.path] : [])),
    ]),
  ];

  return ok({
    source: record.kind === "verification" ? "verification" : "review",
    capturedAt: record.createdAt,
    ...(record.kind === "verification" && record.attempt !== undefined
      ? { attempt: record.attempt }
      : {}),
    failingCommands,
    unresolvedFindings,
    referencedFiles,
  });
}

function isTaskFailure<T extends { task?: string; passed: boolean }>(
  record: T | undefined,
  taskId: string,
): record is T {
  if (record === undefined || record.passed) return false;
  // A record naming another task is that task's failure and must not brief
  // this one. A record naming no task at all was a feature-wide run — the
  // active task is the one being worked, and briefing it beats silence.
  return record.task === undefined || record.task === taskId;
}

/**
 * The files produced by the tasks this one depends on. The dependency edge in
 * the task graph already says "that had to exist before this could start", so
 * its output is the code this task will be calling.
 */
function dependencyOutputs(graph: TaskGraph, task: Task): string[] {
  const byId = new Map(graph.tasks.map((entry) => [entry.id, entry]));

  return [
    ...new Set(
      task.dependsOn.flatMap((id) => {
        const dependency = byId.get(id);
        if (!dependency) return [];
        return dependency.expectedFiles.length > 0
          ? dependency.expectedFiles
          : dependency.allowedFiles;
      }),
    ),
  ];
}

/**
 * Records the hashes of the artifacts this pack was derived from, so a later
 * checkpoint can tell whether the ground moved underneath the work.
 */
async function buildManifest(
  state: WorkspaceState,
  feature: string,
  taskId: string,
  pack: ContextPack,
  graphSnapshotId?: string,
): Promise<Result<ContextManifest>> {
  const sources: ContextManifest["sources"] = [];

  for (const name of [FILE.intent, FILE.spec, FILE.plan, FILE.tasks] as const) {
    const path = state.paths.featureFile(feature, name);
    const text = await state.files.readTextIfExists(path);
    if (!text.ok) return text;
    if (text.value !== undefined) {
      // The same normalisation freshness applies: task-status flips are the
      // loop's own bookkeeping, not drift underneath the pack.
      sources.push({
        path: `${feature}/${name}`,
        hash: sourceHash(`${feature}/${name}`, text.value),
      });
    }
  }

  return ok({
    kind: "context-manifest",
    createdAt: now(),
    feature,
    task: taskId,
    sources,
    contextHash: stableContextHash(pack, graphSnapshotId),
    ...(graphSnapshotId ? { graphSnapshotId } : {}),
  });
}

export { stableContextHash } from "../../../src/workflow/stages/context/digest.js";
