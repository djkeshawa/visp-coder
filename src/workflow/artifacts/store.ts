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
import type { ImplementMarker, Review, Verification } from "./evidence.js";
import { implementMarkerSchema, reviewSchema, verificationSchema } from "./evidence.js";

import { type Intent, intentSchema, type Spec, specSchema } from "./feature.js";
import type { ObservationLog } from "./observations.js";
import { observationLogSchema } from "./observations.js";
import type { Status } from "./project.js";
import { statusSchema } from "./project.js";
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
  protected readonly files: ProjectFileSystem;

  constructor(
    protected readonly paths: ProjectPaths,
    files?: ProjectFileSystem,
  ) {
    this.files = files ?? new RecoveringProjectFileSystem(paths.root);
  }

  readStatusIfExists(): Promise<Result<Status | undefined>> {
    return this.files.readJsonIfExists(this.paths.status, parser(statusSchema, "status.json"));
  }

  readIntent(feature: string): Promise<Result<Intent>> {
    return this.files.readJson(
      this.paths.featureFile(feature, FILE.intent),
      parser(intentSchema, "intent.json"),
    );
  }

  readSpecIfExists(feature: string): Promise<Result<Spec | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.featureFile(feature, FILE.spec),
      parser(specSchema, "spec.json"),
    );
  }

  readTasksIfExists(feature: string): Promise<Result<TaskGraph | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.featureFile(feature, FILE.tasks),
      parser(taskGraphSchema, "tasks.json"),
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

  readObservations(feature: string, task: string): Promise<Result<ObservationLog | undefined>> {
    return this.files.readJsonIfExists(
      this.paths.evidenceFile(feature, task, FILE.observations),
      parser(observationLogSchema, FILE.observations),
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

  /** Evidence also contains feature-wide stores; only task-id directories hold task records. */
  protected async readTaskEvidenceDirectories(feature: string): Promise<Result<string[]>> {
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
