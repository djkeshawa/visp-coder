/**
 * Readers and writers of historical `.visp/` artifacts that VISP itself no longer calls.
 * Tests use them to arrange legacy records the product still reads.
 */
import type { z } from "zod";
import { FILE } from "../../../src/core/constants.js";
import { vispError } from "../../../src/core/errors.js";
import { err, ok, type Result } from "../../../src/core/result.js";
import type {
  ImplementMarker,
  Review,
  Verification,
} from "../../../src/workflow/artifacts/evidence.js";
import { reviewSchema } from "../../../src/workflow/artifacts/evidence.js";

import {
  type Intent,
  type Plan,
  planSchema,
  type Spec,
  specSchema,
  type Traceability,
  traceabilitySchema,
} from "../../../src/workflow/artifacts/feature.js";
import type { ObservationLog } from "../../../src/workflow/artifacts/observations.js";
import type { Status } from "../../../src/workflow/artifacts/project.js";
import type { Research } from "../../../src/workflow/artifacts/research.js";
import { researchSchema } from "../../../src/workflow/artifacts/research.js";
import type { TaskGraph } from "../../../src/workflow/artifacts/tasks.js";
import { taskGraphSchema } from "../../../src/workflow/artifacts/tasks.js";

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

import { ArtifactStore } from "../../../src/workflow/artifacts/store.js";
import type { WorkspaceState } from "../../../src/workflow/state.js";

export class LegacyArtifactStore extends ArtifactStore {
  protected async readEvidenceTrail<S extends z.ZodTypeAny>(
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

  writeStatus(status: Status): Promise<Result<void>> {
    return this.files.writeJson(this.paths.status, status);
  }

  writeIntent(intent: Intent): Promise<Result<void>> {
    return this.files.writeJson(this.paths.featureFile(intent.id, FILE.intent), intent);
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

  writeSpec(spec: Spec): Promise<Result<void>> {
    return this.files.writeJson(this.paths.featureFile(spec.feature, FILE.spec), spec);
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

  writeVerification(verification: Verification): Promise<Result<void>> {
    return this.files.writeJson(
      this.paths.evidenceFile(verification.feature, verification.task, FILE.verification),
      verification,
    );
  }

  writeReview(review: Review): Promise<Result<void>> {
    return this.files.writeJson(
      this.paths.evidenceFile(review.feature, review.task, FILE.review),
      review,
    );
  }

  writeObservations(log: ObservationLog): Promise<Result<void>> {
    return this.files.writeJson(
      this.paths.evidenceFile(log.feature, log.task, FILE.observations),
      log,
    );
  }

  async readAllReviews(feature: string): Promise<Result<Review[]>> {
    return this.readEvidenceTrail(feature, FILE.review, reviewSchema);
  }

  writeImplementMarker(marker: ImplementMarker): Promise<Result<void>> {
    return this.files.writeJson(this.paths.implementMarker(marker.task), marker);
  }
}

export function legacyStore(state: Pick<WorkspaceState, "paths" | "files">): LegacyArtifactStore {
  return new LegacyArtifactStore(state.paths, state.files);
}
