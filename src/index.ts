/** Library surface, for embedding visp rather than shelling out to it. */
export { buildProgram } from "./cli/program.js";
export { createServer } from "./mcp/server.js";

import { RecoveringProjectFileSystem } from "./core/file-transaction.js";
import {
  type WorkspaceState as InternalWorkspaceState,
  resolveFeature as resolveFeatureInternal,
} from "./workflow/state.js";

export { loadConfig } from "./config/load.js";
export { configSchema, defaultConfig, type VispConfig } from "./config/schema.js";
export {
  BLOCK,
  CONFIG_FILE,
  DEFAULT_BLOCKED_PATHS,
  DEFAULT_HARNESS,
  DEFAULT_PRESET,
  DEFAULT_PROFILE,
  DEFAULT_STRICTNESS,
  DERIVED_STATE_PATHS,
  DIR,
  EXIT,
  FILE,
  GUARD_PROTOCOL_VERSION,
  HARD_IGNORED_DIRS,
  HARNESSES,
  type Harness,
  LANGUAGES,
  type Language,
  LEGACY_STATE_IGNORE,
  LIMITS,
  PACKAGE_NAME,
  PRESETS,
  PRODUCT_NAME,
  PROFILES,
  type Preset,
  type Profile,
  RISK_LEVELS,
  type RiskLevel,
  STAGES,
  STATE_DIR,
  STRICTNESS_MODES,
  type Stage,
  type StrictnessMode,
  TASK_CLASSES,
  TASK_STATUSES,
  type TaskClass,
  type TaskStatus,
} from "./core/constants.js";
export { type VispError, vispError } from "./core/errors.js";
export { withStateMutation } from "./core/file-transaction.js";
export { type TaskRef, taskRefKey, taskRefSchema } from "./core/identity.js";
export { ProjectPaths } from "./core/paths.js";
export { err, ok, type Result } from "./core/result.js";
export { inspectStateLock, withStateLock } from "./core/state-lock.js";
export { checkPaths, decideScope, missingExpectedFiles } from "./orchestrate/guard.js";
export {
  checkSkillEvaluation,
  promoteSkill,
  readSkillEvaluation,
  recordSkillEvaluation,
  type SkillEvaluation,
  type SkillEvaluationInput,
  type SkillPreregistration,
  skillPreregistrationSchema,
} from "./skills/evaluation.js";
export {
  type SkillTransitionInput,
  skillSelectionSnapshot,
  transitionSkill,
} from "./skills/lifecycle.js";
export { createProposalFromContent, type ProposalInput } from "./skills/proposal.js";
export { rollbackSkill } from "./skills/rollback.js";
export type { SkillEvidence, SkillRecord, SkillSupport } from "./skills/schema.js";
export { readSkillHistory } from "./skills/store.js";
export { readSkillRevision } from "./skills/versions.js";
export { rebuildTelemetryProjection } from "./telemetry/journal.js";
export type { UsageReceipt, UsageSegment } from "./telemetry/schema.js";
export { readTelemetry } from "./telemetry/store.js";
export {
  type EvidenceContract,
  type EvidenceReceipt,
  evidenceContractSchema,
  evidenceReceiptSchema,
  type OutputSurface,
  outputSurfaceSchema,
} from "./workflow/artifacts/evidence-contract.js";
export {
  type ProductAcceptance,
  type ProductAcceptanceView,
  productAcceptanceSchema,
} from "./workflow/artifacts/product-acceptance.js";
export { ArtifactStore } from "./workflow/artifacts/store.js";
export type { Task, TaskGraph } from "./workflow/artifacts/tasks.js";
export { resolveRule, resolveStage } from "./workflow/policy/resolve.js";
export { RULES, type Rule, type RuleId } from "./workflow/policy/rules.js";
export { runInit } from "./workflow/stages/init.js";
export { loadWorkspace } from "./workflow/state.js";

/**
 * 0.1 embedders constructed this object before project-confined storage was a
 * field. Keep that source shape valid; public entry points supply the safe
 * filesystem when it is absent. States returned by loadWorkspace include it.
 */
export type WorkspaceState = Omit<InternalWorkspaceState, "files"> & {
  readonly files?: InternalWorkspaceState["files"];
};

export function resolveFeature(state: WorkspaceState, explicit?: string) {
  return resolveFeatureInternal(normalizeWorkspaceState(state), explicit);
}

function normalizeWorkspaceState(state: WorkspaceState): InternalWorkspaceState {
  if (state.files) return state as InternalWorkspaceState;
  return {
    ...state,
    files: new RecoveringProjectFileSystem(state.paths.root),
  };
}

export {
  type ObservationsRead,
  readObservations,
} from "./workflow/evidence/observations-reader.js";
export { runProductCapture } from "./workflow/evidence/product-capture.js";
export { runProductControl } from "./workflow/evidence/product-control.js";
export {
  assessmentSchema,
  balancedCritic,
  type CriticAdapter,
  type CriticConfig,
  type CriticPacket,
  coverageAssessmentSchema,
  createProductFeature,
  criticConfigSchema,
  criticRequestSchema,
  criticResponseSchema,
  hasProductFeature,
  PRODUCT_REVIEW_POLICY,
  type ProductAssessment,
  type ProductBrief,
  type ProductBriefUpdate,
  type ProductCoverageAssessment,
  type ProductCriticHost,
  type ProductFeatureOptions,
  type ProductFeatureOutcome,
  type ProductFeedback,
  type ProductFeedbackHost,
  type ProductMigrationOutcome,
  type ProductNext,
  type ProductOutcomeStatus,
  type ProductReviewBundle,
  type ProductReviewChallenge,
  type ProductReviewerContext,
  type ProductReviewOptions,
  type ProductSelection,
  type ProductState,
  type ProductStatus,
  type ProductVerification,
  type ProductWorkContext,
  parseProductBrief,
  productBriefInputSchema,
  productBriefSchema,
  productCheckSchema,
  productFeedbackPlan,
  productFeedbackSchema,
  productReviewChallenges,
  productReviewSubmissionSchema,
  productScopes,
  productStateSchema,
  QUALITY_DIMENSIONS,
  readCriticDefaults,
  readProductBrief,
  reproductionRequestSchema,
  resolveCriticDefault,
  resolveCriticPolicy,
  reviewerContextSchema,
  reviewJudgmentsSchema,
  runProductAccept,
  runProductContext,
  runProductCritic,
  runProductDone,
  runProductHostFeedback,
  runProductMigrate,
  runProductNext,
  runProductReport,
  runProductReproduction,
  runProductReview,
  runProductReviewerHandoff,
  runProductReviewRequest,
  runProductStatus,
  runProductUserFeedback,
  runProductVerify,
  runProductWork,
  saveCriticDefaults,
  saveCriticEnabled,
  type UserFeedbackHost,
  updateProductBrief,
} from "./workflow/product/index.js";
export { productInputTemplate } from "./workflow/product-inputs.js";
