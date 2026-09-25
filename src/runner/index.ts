export { adapterFor, type HostAdapter } from "./adapters.js";
export type { SourceSnapshot } from "./artifacts.js";
export {
  inspectStudyBudget,
  reserveStudyBudget,
  type StudyBudgetRequest,
  type StudyBudgetReservation,
} from "./budgets.js";
export {
  assignComparisons,
  COMPARISON_ARMS,
  COMPARISON_POLICY,
  type ComparisonObservation,
  type ComparisonSpec,
  comparisonObservationSchema,
  comparisonSpecSchema,
  type PreparedComparison,
  prepareComparison,
  readPreparedComparison,
  summarizeComparison,
} from "./comparison.js";
export {
  type AdapterCapabilities,
  type Assignment,
  assignmentSchema,
  type HostEvent,
  type NormalizedUsage,
  type PriceSnapshot,
  priceSnapshotSchema,
  type RunnerHost,
  type RunnerResult,
  type RunnerSpec,
  type RunnerStatus,
  runnerHostSchema,
  runnerSpecSchema,
  type TaskRef,
  taskRefSchema,
} from "./contracts.js";
export { criticComparisonConfigSchema, prepareCriticComparison } from "./critic-comparison.js";
export {
  assignPilot,
  type Confirmation,
  confirmationSchema,
  decideEscalation,
  type EscalationInput,
  type PilotAssignment,
  type PilotScenario,
  type Preregistration,
  preregistrationSchema,
  type StudyObservation,
  studyObservationSchema,
  summarizeStudy,
} from "./evaluation.js";
export {
  buildContainerArguments,
  type EvaluatorSpec,
  evaluateReport,
  evaluateRun,
  evaluatorSpecSchema,
  hashEvaluatorPolicy,
  inspectEvaluation,
} from "./evaluator.js";
export {
  type FeedbackLoopSummary,
  feedbackLoopSchema,
  type LoopReview,
  loopReviewSchema,
} from "./loop-contracts.js";
export {
  parseTestReport,
  type ReportedTest,
  type ReportFormat,
  type TestReport,
  type TestStatus,
} from "./reports.js";
export { prepareReviewCalibration, reviewCalibrationSchema } from "./review-calibration.js";
export { inspectRun, type RunnerOptions, runExperiment } from "./run.js";
export type { RunManifest } from "./run-support.js";
