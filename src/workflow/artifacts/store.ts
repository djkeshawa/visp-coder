import type { z } from "zod";
import { FILE } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { RecoveringProjectFileSystem } from "../../core/file-transaction.js";
import type { ProjectFileSystem } from "../../core/fs.js";
import { featureIdSchema, taskIdSchema } from "../../core/input.js";
import type { ProjectPaths } from "../../core/paths.js";
import { err, ok, type Result } from "../../core/result.js";
import type { ContextManifest, ContextPack } from "./context.js";
import { contextManifestSchema, contextPackSchema } from "./context.js";
import type { ImplementMarker, PullRequest, Review, Verification } from "./evidence.js";
import {
  implementMarkerSchema,
  pullRequestSchema,
  reviewSchema,
  verificationSchema,
} from "./evidence.js";
import { type EvidenceWriteOptions, writeEvidenceAttempt } from "./evidence-persistence.js";

export type { EvidenceWriteOptions } from "./evidence-persistence.js";

import {
  type Intent,
  intentSchema,
  type Plan,
  planSchema,
  type Spec,
  specSchema,
  type Traceability,
  traceabilitySchema,
} from "./feature.js";
import type { ObservationLog } from "./observations.js";
import { observationLogSchema } from "./observations.js";
import { type ProductAcceptance, productAcceptanceSchema } from "./product-acceptance.js";
import type { Project, Status } from "./project.js";
import { projectSchema, statusSchema } from "./project.js";
import type { Research } from "./research.js";
import { researchSchema } from "./research.js";
import type { TaskGraph } from "./tasks.js";
import { taskGraphSchema } from "./tasks.js";

/** Turns a zod schema into the parse function the fs helpers expect. */
function parser<S extends z.ZodTypeAny>(schema: S, label: string) {
  return (value: unknown): Result<z.output<S>> => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return ok(parsed.data);
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return err(vispError("ARTIFACT_INVALID", `Invalid ${label}: ${detail}`));
  };
}

/**
 * Typed reads and writes of every `.visp/` artifact. Nothing else touches these
 * files directly.
 */
export class ArtifactStore {
  private readonly files: ProjectFileSystem;

  constructor(
    private readonly paths: ProjectPaths,
    files?: ProjectFileSystem,
  ) {
    this.files = files ?? new RecoveringProjectFileSystem(paths.root);
  }

  readProject(): Promise<Result<Project>> {
    return this.files.readJson(this.paths.project, parser(projectSchema, "project.json"));
  }

  writeProject(project: Project): Promise<Result<void>> {
    return this.files.writeJson(this.paths.project, project);
  }

  readStatus(): Promise<Result<Status>> {
    return this.files.readJson(this.paths.status, parser(statusSchema, "status.json"));
  }

  readStatusIfExists(): Promise<Result<Status | undefined>> {
    return this.files.readJsonIfExists(this.paths.status, parser(statusSchema, "status.json"));
  }

  writeStatus(status: Status): Promise<Result<void>> {
    return this.files.writeJson(this.paths.status, status);
  }

  readIntent(feature: string): Promise<Result<Intent>> {
    return this.files.readJson(
      this.paths.featureFile(feature, FILE.intent),
      parser(intentSchema, "intent.json"),
    );
  }

  writeIntent(intent: Intent): Promise<Result<void>> {
    return this.files.writeJson(this.paths.featureFile(intent.id, FILE.intent), intent);
  }

  readResearch(feature: string): Promise<Result<Research>> {
    return this.files.readJson(
      this.paths.featureFile(feature, FILE.research),
      parser(researchSchema, FILE.research),
    );
  }

  readResearchIfExists(feature: string): Promise<Result<Research | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.featureFile(feature, FILE.research),
      parser(researchSchema, FILE.research),
    );
  }

  writeResearch(research: Research): Promise<Result<void>> {
    return this.files.writeJson(this.paths.featureFile(research.feature, FILE.research), research);
  }

  readSpec(feature: string): Promise<Result<Spec>> {
    return this.files.readJson(
      this.paths.featureFile(feature, FILE.spec),
      parser(specSchema, "spec.json"),
    );
  }

  readSpecIfExists(feature: string): Promise<Result<Spec | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.featureFile(feature, FILE.spec),
      parser(specSchema, "spec.json"),
    );
  }

  writeSpec(spec: Spec): Promise<Result<void>> {
    return this.files.writeJson(this.paths.featureFile(spec.feature, FILE.spec), spec);
  }

  readProductAcceptance(feature: string): Promise<Result<ProductAcceptance | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.featureFile(feature, FILE.productAcceptance),
      parser(productAcceptanceSchema, FILE.productAcceptance),
    );
  }

  writeProductAcceptance(record: ProductAcceptance): Promise<Result<void>> {
    return this.files.writeJson(
      this.paths.featureFile(record.feature, FILE.productAcceptance),
      record,
    );
  }

  readPlan(feature: string): Promise<Result<Plan>> {
    return this.files.readJson(
      this.paths.featureFile(feature, FILE.plan),
      parser(planSchema, "plan.json"),
    );
  }

  readPlanIfExists(feature: string): Promise<Result<Plan | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.featureFile(feature, FILE.plan),
      parser(planSchema, "plan.json"),
    );
  }

  writePlan(plan: Plan): Promise<Result<void>> {
    return this.files.writeJson(this.paths.featureFile(plan.feature, FILE.plan), plan);
  }

  readTasks(feature: string): Promise<Result<TaskGraph>> {
    return this.files.readJson(
      this.paths.featureFile(feature, FILE.tasks),
      parser(taskGraphSchema, "tasks.json"),
    );
  }

  readTasksIfExists(feature: string): Promise<Result<TaskGraph | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.featureFile(feature, FILE.tasks),
      parser(taskGraphSchema, "tasks.json"),
    );
  }

  writeTasks(graph: TaskGraph): Promise<Result<void>> {
    return this.files.writeJson(this.paths.featureFile(graph.feature, FILE.tasks), graph);
  }

  readTraceability(feature: string): Promise<Result<Traceability | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.featureFile(feature, FILE.traceability),
      parser(traceabilitySchema, "traceability.json"),
    );
  }

  writeTraceability(traceability: Traceability): Promise<Result<void>> {
    return this.files.writeJson(
      this.paths.featureFile(traceability.feature, FILE.traceability),
      traceability,
    );
  }

  /**
   * Evidence is written where it was earned. Asking for a task's record falls
   * back to the feature-wide one, which is what an unscoped `verify` writes.
   */
  async readVerification(
    feature: string,
    task?: string,
  ): Promise<Result<Verification | undefined>> {
    const scoped = await this.files.readJsonIfExists(
      this.paths.evidenceFile(feature, task, FILE.verification),
      parser(verificationSchema, FILE.verification),
    );
    if (!scoped.ok || scoped.value || task === undefined) return scoped;
    return this.files.readJsonIfExists(
      this.paths.evidenceFile(feature, undefined, FILE.verification),
      parser(verificationSchema, FILE.verification),
    );
  }

  writeVerification(verification: Verification): Promise<Result<void>> {
    return this.files.writeJson(
      this.paths.evidenceFile(verification.feature, verification.task, FILE.verification),
      verification,
    );
  }

  async writeVerificationAttempt(
    verification: Verification,
    options: EvidenceWriteOptions = {},
  ): Promise<Result<void>> {
    return writeEvidenceAttempt(
      this.paths,
      this.files,
      FILE.verification,
      verification,
      verificationSchema,
      options,
    );
  }

  readVerificationAttempts(feature: string, task?: string): Promise<Result<Verification[]>> {
    return this.readEvidenceAttempts(feature, task, FILE.verification, verificationSchema);
  }

  async readReview(feature: string, task?: string): Promise<Result<Review | undefined>> {
    const scoped = await this.files.readJsonIfExists(
      this.paths.evidenceFile(feature, task, FILE.review),
      parser(reviewSchema, FILE.review),
    );
    if (!scoped.ok || scoped.value || task === undefined) return scoped;
    return this.files.readJsonIfExists(
      this.paths.evidenceFile(feature, undefined, FILE.review),
      parser(reviewSchema, FILE.review),
    );
  }

  writeReview(review: Review): Promise<Result<void>> {
    return this.files.writeJson(
      this.paths.evidenceFile(review.feature, review.task, FILE.review),
      review,
    );
  }

  async writeReviewAttempt(
    review: Review,
    options: EvidenceWriteOptions = {},
  ): Promise<Result<void>> {
    return writeEvidenceAttempt(this.paths, this.files, FILE.review, review, reviewSchema, options);
  }

  readReviewAttempts(feature: string, task?: string): Promise<Result<Review[]>> {
    return this.readEvidenceAttempts(feature, task, FILE.review, reviewSchema);
  }

  readObservations(feature: string, task: string): Promise<Result<ObservationLog | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.evidenceFile(feature, task, FILE.observations),
      parser(observationLogSchema, FILE.observations),
    );
  }

  writeObservations(log: ObservationLog): Promise<Result<void>> {
    return this.files.writeJson(
      this.paths.evidenceFile(log.feature, log.task, FILE.observations),
      log,
    );
  }

  async readAllObservations(feature: string): Promise<Result<ObservationLog[]>> {
    const tasks = await this.readTaskEvidenceDirectories(feature);
    if (!tasks.ok) return tasks;

    const logs: ObservationLog[] = [];
    for (const task of tasks.value) {
      const log = await this.readObservations(feature, task);
      if (!log.ok) return log;
      if (log.value) logs.push(log.value);
    }
    return ok(logs);
  }

  /** Every task's evidence plus the feature-wide record, for summaries. */
  async readAllVerifications(feature: string): Promise<Result<Verification[]>> {
    return this.readEvidenceTrail(feature, FILE.verification, verificationSchema);
  }

  async readAllReviews(feature: string): Promise<Result<Review[]>> {
    return this.readEvidenceTrail(feature, FILE.review, reviewSchema);
  }

  private async readEvidenceTrail<S extends z.ZodTypeAny>(
    feature: string,
    name: string,
    schema: S,
  ): Promise<Result<z.output<S>[]>> {
    const tasks = await this.readTaskEvidenceDirectories(feature);
    if (!tasks.ok) return tasks;

    const records: z.output<S>[] = [];
    for (const task of [undefined, ...tasks.value]) {
      const record = await this.files.readJsonIfExists(
        this.paths.evidenceFile(feature, task, name),
        parser(schema, name),
      );
      if (!record.ok) return record;
      if (record.value) records.push(record.value);
    }
    return ok(records);
  }

  /** Evidence also contains feature-wide stores; only task-id directories hold task records. */
  private async readTaskEvidenceDirectories(feature: string): Promise<Result<string[]>> {
    const entries = await this.files.listDirectories(this.paths.evidenceDir(feature));
    return entries.ok
      ? ok(entries.value.filter((entry) => taskIdSchema.safeParse(entry).success))
      : entries;
  }

  private async readEvidenceAttempts<S extends z.ZodTypeAny>(
    feature: string,
    task: string | undefined,
    name: string,
    schema: S,
  ): Promise<Result<z.output<S>[]>> {
    const directory = this.paths.evidenceAttemptsDir(feature, task, name);
    const entries = await this.files.listDir(directory);
    if (!entries.ok) return entries;

    const records: z.output<S>[] = [];
    for (const entry of entries.value.filter((path) => path.endsWith(".json"))) {
      const record = await this.files.readJson(
        this.paths.evidenceAttemptFile(feature, task, name, entry.slice(0, -".json".length)),
        parser(schema, `${name} attempt`),
      );
      if (!record.ok) return record;
      records.push(record.value);
    }
    return ok(records);
  }

  writePullRequest(pr: PullRequest): Promise<Result<void>> {
    return this.files.writeJson(this.paths.featureFile(pr.feature, FILE.pullRequest), pr);
  }

  readPullRequest(feature: string): Promise<Result<PullRequest | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.featureFile(feature, FILE.pullRequest),
      parser(pullRequestSchema, FILE.pullRequest),
    );
  }

  readContextPack(feature: string, taskId: string): Promise<Result<ContextPack | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.contextFile(feature, taskId),
      parser(contextPackSchema, "context pack"),
    );
  }

  readContextManifest(
    feature: string,
    taskId: string,
  ): Promise<Result<ContextManifest | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.contextManifest(feature, taskId),
      parser(contextManifestSchema, "context manifest"),
    );
  }

  readImplementMarker(taskId: string): Promise<Result<ImplementMarker | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.implementMarker(taskId),
      parser(implementMarkerSchema, "implement marker"),
    );
  }

  writeImplementMarker(marker: ImplementMarker): Promise<Result<void>> {
    return this.files.writeJson(this.paths.implementMarker(marker.task), marker);
  }

  clearImplementMarker(taskId: string): Promise<Result<void>> {
    return this.files.removeFile(this.paths.implementMarker(taskId));
  }

  /** Every active authorization. Hooks read all of them; forbidden wins. */
  async readActiveMarkers(): Promise<Result<ImplementMarker[]>> {
    const entries = await this.files.listDir(this.paths.implementMarkersDir);
    if (!entries.ok) return entries;

    const markers: ImplementMarker[] = [];
    for (const entry of entries.value) {
      if (!entry.endsWith(".json")) continue;
      const marker = await this.readImplementMarker(entry.slice(0, -".json".length));
      if (!marker.ok) return marker;
      if (marker.value) markers.push(marker.value);
    }
    return ok(markers);
  }

  /** Feature directories, newest id first. */
  async listFeatures(): Promise<Result<string[]>> {
    const entries = await this.files.listDirectories(this.paths.featuresDir);
    if (!entries.ok) return entries;
    return ok(entries.value.filter((name) => featureIdSchema.safeParse(name).success).reverse());
  }
}
