import type { z } from "zod";
import type { TaskClass } from "../../core/constants.js";
import { planDerivedStateIgnore } from "../../core/derived-ignore.js";
import { vispError } from "../../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
  withStateMutation,
} from "../../core/file-transaction.js";
import { sha256 } from "../../core/hash.js";
import { parseFeatureId } from "../../core/input.js";
import { err, ok, type Result } from "../../core/result.js";
import {
  type Intent,
  intentSchema,
  type Plan,
  planSchema,
  type Spec,
  specSchema,
} from "../artifacts/feature.js";
import {
  type ProductAcceptance,
  productAcceptanceSchema,
} from "../artifacts/product-acceptance.js";
import { type Research, researchSchema } from "../artifacts/research.js";
import { type TaskGraph, taskGraphSchema, validationChecksFor } from "../artifacts/tasks.js";
import type { WorkspaceState } from "../state.js";
import {
  type CriticBudgetMigration,
  planCriticBudgetMigration,
} from "./critic-budget-migration.js";
import { requireNoPendingCriticReview } from "./critic-policy.js";
import {
  type FindingIdentityMigration,
  planFindingIdentityMigration,
} from "./finding-migration.js";
import {
  initialProductState,
  type ProductBrief,
  type ProductCheck,
  parseProductBrief,
} from "./model.js";
import { planStateVersionMigration } from "./state-version-migration.js";
import {
  briefPath,
  json,
  type ProductSelection,
  readProductRecordForMigration,
  recordMutations,
} from "./store.js";

export interface ProductMigrationOutcome {
  readonly dryRun: boolean;
  readonly features: readonly {
    feature: string;
    status: "migrated" | "history-upgraded" | "already-current";
    historicalComplete: boolean;
    slices: number;
    preservedFiles: readonly string[];
    findingIdentity?: FindingIdentityMigration;
    criticBudget?: CriticBudgetMigration;
  }[];
  readonly changed: number;
}
interface LegacyData {
  intent: Intent;
  spec?: Spec;
  plan?: Plan;
  research?: Research;
  tasks?: TaskGraph;
  taskClasses: ReadonlyMap<string, TaskClass>;
  acceptance?: ProductAcceptance;
}
interface Snapshot {
  path: string;
  content: string;
  mode?: number;
}

export async function runProductMigrate(
  workspace: WorkspaceState,
  options: ProductSelection & { readonly dryRun?: boolean } = {},
): Promise<Result<ProductMigrationOutcome>> {
  if (options.feature !== undefined) {
    const valid = parseFeatureId(options.feature);
    if (!valid.ok) return valid;
  }
  // A dry run must not create locks, recover journals, or rewrite history.
  const operation = () => migrate(workspace, options);
  return options.dryRun ? operation() : withStateMutation(workspace.paths.root, operation);
}

async function migrate(
  workspace: WorkspaceState,
  options: ProductSelection & { readonly dryRun?: boolean },
): Promise<Result<ProductMigrationOutcome>> {
  const planned = await planProductMigration(workspace, options);
  if (!planned.ok) return planned;
  const { mutations, features } = planned.value;
  if (options.dryRun) return ok({ dryRun: true, features, changed: mutations.length });
  if (features.some((feature) => feature.status === "history-upgraded"))
    return err(
      vispError(
        "MIGRATION_REQUIRED",
        "Current history upgrades require a standalone backup transaction",
        {
          recovery:
            "visp-migrate --project <project> preview, then visp-migrate --project <project> apply",
        },
      ),
    );
  const saved = await applyFileTransaction(
    workspace.paths.root,
    "migrate-product-workflow",
    mutations,
  );
  return saved.ok ? ok({ dryRun: false, features, changed: saved.value.changed }) : saved;
}

/** Application runs under writer ownership; preview remains available during review. */
export async function guardProductMigration(
  workspace: WorkspaceState,
  features: ProductMigrationOutcome["features"],
) {
  for (const feature of features) {
    if (feature.status !== "history-upgraded") continue;
    const allowed = await requireNoPendingCriticReview(
      workspace,
      feature.feature,
      "Submit or expire the pending critic review before applying history migration",
    );
    if (!allowed.ok) return allowed;
  }
  return ok(undefined);
}

/** Read-only plan shared by the standalone migration executable and the retiring runtime adapter. */
export async function planProductMigration(
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<{ mutations: FileMutation[]; features: ProductMigrationOutcome["features"] }>> {
  if (options.feature !== undefined) {
    const valid = parseFeatureId(options.feature);
    if (!valid.ok) return valid;
  }
  const ids = options.feature ? ok([options.feature]) : await workspace.store.listFeatures();
  if (!ids.ok) return ids;
  const mutations: FileMutation[] = [];
  const features: ProductMigrationOutcome["features"][number][] = [];
  for (const feature of ids.value) {
    const planned = await planFeatureMigration(workspace, feature);
    if (!planned.ok) return planned;
    mutations.push(...planned.value.mutations);
    features.push(planned.value.feature);
  }
  const migrated = new Set(
    features.filter((feature) => feature.status === "migrated").map((feature) => feature.feature),
  );
  const ignore = await planDerivedStateIgnore(workspace.files, workspace.paths.root);
  if (!ignore.ok) return ignore;
  if (ignore.value) mutations.push(ignore.value);
  const retired = await planMarkerRetirement(workspace, migrated);
  if (!retired.ok) return retired;
  mutations.push(...retired.value);
  return ok({ mutations, features });
}

async function planMarkerRetirement(
  workspace: WorkspaceState,
  migrated: Set<string>,
): Promise<Result<FileMutation[]>> {
  const markers = await workspace.store.readActiveMarkers();
  if (!markers.ok) return markers;
  const mutations: FileMutation[] = [];
  for (const marker of markers.value) {
    if (!migrated.has(marker.feature)) continue;
    const path = workspace.paths.implementMarker(marker.task);
    const content = await workspace.files.readText(path);
    if (!content.ok) return content;
    mutations.push({ kind: "remove", path, expectedBefore: filePrecondition(content.value) });
  }
  return ok(mutations);
}

function wasHistoricallyComplete(data: LegacyData): boolean {
  return (
    !!data.tasks &&
    !data.tasks.draft &&
    data.tasks.tasks.length > 0 &&
    data.tasks.tasks.every((task) => task.status === "done") &&
    (data.intent.finalAcceptance !== true || data.acceptance?.passed === true)
  );
}

async function planFeatureMigration(
  workspace: WorkspaceState,
  feature: string,
): Promise<
  Result<{
    mutations: FileMutation[];
    feature: ProductMigrationOutcome["features"][number];
  }>
> {
  const current = await workspace.files.exists(briefPath(workspace, feature));
  if (!current.ok) return current;
  if (current.value) return planCurrentFeatureMigration(workspace, feature);
  const legacy = await readLegacy(workspace, feature);
  if (!legacy.ok) return legacy;
  const translated = translate(legacy.value.data);
  if (!translated.ok) return translated;
  const brief = translated.value;
  const timestamp = new Date().toISOString();
  const state = initialProductState(brief, timestamp);
  for (const task of legacy.value.data.tasks?.tasks ?? []) {
    const slice = state.slices[task.id];
    if (slice) slice.status = task.status === "done" ? "legacy-closed" : "pending";
  }
  const historicalComplete = wasHistoricallyComplete(legacy.value.data);
  if (historicalComplete) state.status = "historical-complete";
  const mutations: FileMutation[] = [
    ...recordMutations(workspace, undefined, brief, state),
    ...legacy.value.absences,
  ];
  const manifest = {
    version: 2,
    feature,
    createdAt: timestamp,
    sourceVersion: 1,
    historicalComplete,
    requiresFreshAcceptance: !historicalComplete,
    sources: legacy.value.snapshots.map((entry) => ({
      path: workspace.paths.relative(entry.path),
      sha256: sha256(entry.content),
    })),
    legacyIds: {
      outcomes: brief.outcomes.map((entry) => entry.id),
      examples: brief.examples.map((entry) => entry.id),
      slices: brief.slices.map((entry) => entry.id),
    },
  };
  mutations.push({
    kind: "write",
    path: workspace.paths.featureFile(feature, "migration.json"),
    content: json(manifest),
    expectedBefore: { existed: false },
  });
  // Preserve bytes and assert the exact legacy source preimages in the same transaction.
  mutations.push(
    ...legacy.value.snapshots.map((entry) => ({
      kind: "write" as const,
      path: entry.path,
      content: entry.content,
      mode: entry.mode,
      expectedBefore: filePrecondition(entry.content, entry.mode),
    })),
  );
  return ok({
    mutations,
    feature: {
      feature,
      status: "migrated",
      historicalComplete,
      slices: brief.slices.length,
      preservedFiles: legacy.value.snapshots.map(
        (entry) => workspace.paths.relative(entry.path) ?? entry.path,
      ),
    },
  });
}

async function planCurrentFeatureMigration(
  workspace: WorkspaceState,
  feature: string,
): Promise<
  Result<{ mutations: FileMutation[]; feature: ProductMigrationOutcome["features"][number] }>
> {
  const record = await readProductRecordForMigration(workspace, { feature });
  if (!record.ok) return record;
  const identity = await planFindingIdentityMigration(workspace, record.value);
  if (!identity.ok) return identity;
  const budget = await planCriticBudgetMigration(
    workspace,
    record.value,
    planStateVersionMigration(workspace, record.value, identity.value.mutations),
  );
  if (!budget.ok) return budget;
  return ok({
    mutations: budget.value.mutations,
    feature: {
      feature,
      status: budget.value.mutations.length ? "history-upgraded" : "already-current",
      ...(budget.value.report ? { criticBudget: budget.value.report } : {}),
      ...(identity.value.report ? { findingIdentity: identity.value.report } : {}),
      historicalComplete: record.value.state.status === "historical-complete",
      slices: record.value.brief.slices.length,
      preservedFiles: [],
    },
  });
}

async function readLegacy(
  workspace: WorkspaceState,
  feature: string,
): Promise<Result<{ data: LegacyData; snapshots: Snapshot[]; absences: FileMutation[] }>> {
  const snapshots: Snapshot[] = [];
  const absences: FileMutation[] = [];
  async function artifact<T>(
    name: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    required = false,
  ): Promise<Result<T | undefined>> {
    const path = workspace.paths.featureFile(feature, name);
    const content = await workspace.files.readTextIfExists(path);
    if (!content.ok) return content;
    if (content.value === undefined) {
      if (required)
        return err(vispError("ARTIFACT_MISSING", `Missing legacy ${name} for ${feature}`));
      // A missing optional artifact is an input too: concurrent creation must abort.
      absences.push({ kind: "remove", path, expectedBefore: { existed: false } });
      return ok(undefined);
    }
    let value: unknown;
    try {
      value = JSON.parse(content.value);
    } catch {
      return err(vispError("ARTIFACT_INVALID", `Malformed legacy ${name} for ${feature}`));
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      return err(vispError("ARTIFACT_INVALID", `Invalid legacy ${name}: ${parsed.error.message}`));
    const metadata = await workspace.files.metadata(path);
    if (!metadata.ok) return metadata;
    snapshots.push({ path, content: content.value, mode: metadata.value?.mode });
    return ok(parsed.data);
  }
  const intent = await artifact("intent.json", intentSchema, true);
  if (!intent.ok) return intent;
  if (!intent.value || intent.value.id !== feature)
    return err(vispError("ARTIFACT_INVALID", "Legacy intent ID mismatch"));
  const spec = await artifact("spec.json", specSchema);
  if (!spec.ok) return spec;
  const plan = await artifact("plan.json", planSchema);
  if (!plan.ok) return plan;
  const research = await artifact("research.json", researchSchema);
  if (!research.ok) return research;
  const tasks = await artifact("tasks.json", taskGraphSchema);
  if (!tasks.ok) return tasks;
  const acceptance = await artifact("acceptance.json", productAcceptanceSchema);
  if (!acceptance.ok) return acceptance;
  for (const value of [spec.value, plan.value, research.value, tasks.value, acceptance.value])
    if (value && value.feature !== feature)
      return err(vispError("ARTIFACT_INVALID", "Legacy artifact feature mismatch"));
  return ok({
    data: {
      intent: intent.value,
      spec: spec.value,
      plan: plan.value,
      research: research.value,
      tasks: tasks.value,
      taskClasses: recordedTaskClasses(
        snapshots.find(
          (entry) => entry.path === workspace.paths.featureFile(feature, "tasks.json"),
        ),
      ),
      acceptance: acceptance.value,
    },
    snapshots,
    absences,
  });
}

function verificationCommand(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const fenced = /^\s*```(?:\w+)?\s*\n([^\n]+)\n```\s*$/.exec(value);
  const inline = /^\s*`([^`\n]+)`\s*$/.exec(value);
  return fenced?.[1] ?? inline?.[1];
}

function translateOutcome(
  requirement:
    | NonNullable<LegacyData["spec"]>["requirements"][number]
    | NonNullable<LegacyData["spec"]>["qualityRequirements"][number],
  checks: ProductCheck[],
) {
  for (const criterion of requirement.criteria) {
    const command = verificationCommand(criterion.verification);
    if (command)
      checks.push({
        id: criterion.id,
        command,
        outcomes: [requirement.id],
        files: [],
        environment: criterion.verificationEnvironment === "browser" ? "browser" : "other",
      });
  }
  return {
    id: requirement.id,
    kind:
      "category" in requirement
        ? ["visual", "usability"].includes(String(requirement.category))
          ? "experience"
          : "quality"
        : "functional",
    statement: requirement.statement,
    priority: requirement.priority,
    provenance: "legacy",
    ...("target" in requirement ? { target: requirement.target } : {}),
    reviewRequired: requirement.criteria.some(
      (criterion) =>
        criterion.observationKind === "visual" || criterion.evidenceContract?.reviewRequired,
    ),
    expectations: requirement.criteria.map((criterion) => ({
      id: criterion.id,
      statement: criterion.statement,
      provenance: "legacy",
    })),
  };
}

function translateDecisions(research: Research | undefined, plan: Plan | undefined) {
  const decisions = (research?.findings ?? []).map((finding) => ({
    id: finding.id,
    statement: finding.statement,
    rationale: [
      `${finding.classification}; confidence ${finding.confidence}`,
      ...(finding.challenge ? [json(finding.challenge)] : []),
    ].join("\n"),
    evidence: finding.sources.map(
      (source) => `${source.reference}${source.detail ? `: ${source.detail}` : ""}`,
    ),
    implications: finding.implications.map((implication) => implication.statement),
    outcomes: [],
  }));
  for (const [index, decision] of (plan?.decisions ?? []).entries())
    decisions.push({
      id: `D${String(index + 1).padStart(3, "0")}`,
      statement: decision.statement,
      rationale: decision.rationale,
      evidence: [],
      implications: [],
      outcomes: [],
    });
  if (plan?.approach)
    decisions.push({
      id: "DApproach",
      statement: plan.approach,
      rationale: "Preserved legacy implementation approach",
      evidence: [],
      implications: [...plan.invariants, ...plan.risks],
      outcomes: [],
    });
  for (const question of research?.questions ?? []) {
    if (question.answer)
      decisions.push({
        id: question.id,
        statement: question.question,
        rationale: question.answer,
        evidence: [],
        implications: [],
        outcomes: [],
      });
  }
  return decisions;
}

function translate({
  intent,
  spec,
  plan,
  research,
  tasks,
  taskClasses,
}: LegacyData): Result<ProductBrief> {
  const checks: ProductCheck[] = [];
  const requirements = [...(spec?.requirements ?? []), ...(spec?.qualityRequirements ?? [])];
  const outcomes = requirements.map((requirement) => translateOutcome(requirement, checks));
  const slices = (tasks?.tasks ?? []).map((task) => {
    const taskChecks = validationChecksFor(task).map((check, index) => ({
      id: `${task.id}_C${index + 1}`,
      command: check.command,
      outcomes: [...task.requirements, ...task.qualityRequirements],
      files: task.validationFiles,
      environment: "other" as const,
    }));
    checks.push(...taskChecks);
    return {
      id: task.id,
      goal: task.title,
      ...(taskClasses.has(task.id) ? { taskClass: taskClasses.get(task.id) } : {}),
      approach: [task.description, ...task.doneCriteria].filter(Boolean).join("\n"),
      outcomes: [...task.requirements, ...task.qualityRequirements],
      dependsOn: task.dependsOn,
      scope: {
        allowed: task.allowedFiles,
        expected: task.expectedFiles,
        forbidden: task.forbiddenFiles,
      },
      checks: taskChecks.map((check) => check.id),
    };
  });
  const decisions = translateDecisions(research, plan);
  return parseProductBrief({
    version: 2,
    incomplete: !spec || spec.draft || tasks?.draft === true,
    feature: intent.id,
    originalRequest: intent.sourceBrief ?? intent.goal,
    goal: intent.goal,
    outcomes,
    examples: (spec?.behaviorScenarios ?? []).map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      given: scenario.given,
      when: scenario.when,
      expected: scenario.expected,
      outcomes: scenario.requirements,
    })),
    decisions,
    uncertainties: [
      ...(research?.unknowns ?? []),
      ...(research?.questions
        .filter((question) => question.status === "open" || question.status === "deferred")
        .map((question) => question.question) ?? []),
      ...(spec?.openQuestions ?? []),
      ...(!spec || spec.draft
        ? [
            "Legacy specification is incomplete; interpret the original request before implementation.",
          ]
        : []),
    ],
    checks,
    slices,
    acceptanceBaseline: intent.acceptanceBaseline ?? [],
    ...(spec?.designBrief
      ? {
          design: {
            description: json(spec.designBrief),
            references: spec.designBrief.references.map((entry) => entry.source),
            refinementCycles: 2,
          },
        }
      : {}),
  });
}

/** The snapshot already passed taskGraphSchema; only on-disk values establish recorded classes. */
function recordedTaskClasses(snapshot: Snapshot | undefined): ReadonlyMap<string, TaskClass> {
  if (!snapshot) return new Map();
  const raw = JSON.parse(snapshot.content) as {
    tasks?: Array<{ id: string; taskClass?: TaskClass }>;
  };
  return new Map(
    (raw.tasks ?? []).flatMap((task) =>
      task.taskClass === undefined ? [] : [[task.id, task.taskClass] as const],
    ),
  );
}
