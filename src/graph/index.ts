/**
 * The repository intelligence graph: index a worktree without running it, then
 * answer bounded structural questions about it.
 */

export { type CurrencyReport, type CurrencyState, checkCurrency } from "./currency.js";
export { parseCount, resetParseCount } from "./extract/parser.js";
export { fileEntityId, pathOfEntityId } from "./ids.js";
export {
  hasIndexableProjectFiles,
  isIndexableProjectPath,
  isTestPath,
  languageForPath,
} from "./paths.js";
export {
  collapseToFileGraph,
  coverageFor,
  type EntityRegion,
  type ExternalDependency,
  entityRegions,
  type FileEdge,
  type FileGraph,
  type GraphProjection,
  type Neighbourhood,
  type NeighbourhoodFile,
  projectGraph,
  structuralDistances,
  structuralNeighbourhood,
} from "./projection.js";
export {
  clampBudget,
  QUERY_OPERATIONS,
  type QueryArgs,
  type QueryBudget,
  type QueryEnvelope,
  type QueryOperation,
  type QueryReceipt,
  type QueryRow,
  type QueryWork,
  queryGraph,
  querySnapshot,
  type RepoSummary,
} from "./query/index.js";
export {
  diffFiles,
  type FileDiff,
  type IndexReport,
  indexRepository,
  refreshRepository,
} from "./refresh.js";
export { GraphStore, openProjectStore, openStore } from "./store/index.js";
export type {
  Entity,
  EntityKind,
  Entrypoint,
  EntrypointKind,
  FileEntry,
  FileLanguage,
  GraphSnapshot,
  LanguageCoverage,
  Relation,
  RelationKind,
  SkippedFile,
  SkipReason,
  UnknownKind,
  UnknownRecord,
  WalkResult,
} from "./types.js";
export { walkRepository, worktreeFingerprint } from "./walker/index.js";
