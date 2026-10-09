import { resolveCriticPolicy } from "../../config/critic-defaults.js";
import type { RiskLevel } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
} from "../../core/file-transaction.js";
import { createBranch, currentBranch } from "../../core/git.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { redactRequest } from "../../core/redaction.js";
import { err, ok, type Result } from "../../core/result.js";
import { laterChanges } from "../../memory/later-changes.js";
import {
  type EarlierFeature,
  MEMORY_HEADING,
  MEMORY_HEADING_WITH_LATER_CHANGES,
  memoryBriefFor,
  notInRequest,
  PROJECT_MEMORY_FILE,
  projectMemoryText,
  recordEarlierRequests,
} from "../../memory/memory-service.js";
import { recordRequestHistory } from "../../memory/request-history.js";
import type { AcceptanceBaseline } from "../artifacts/acceptance.js";
import type { Intent } from "../artifacts/feature.js";
import { captureAcceptanceBaseline } from "../evidence/acceptance.js";
import { requireFeatureFoundation, requireImplementationFoundation } from "../gates/readiness.js";
import type { WorkspaceState } from "../state.js";
import { normalizeBriefInput } from "./brief-aliases.js";
import { patchProductBrief } from "./brief-patch.js";
import { planCriticRevision } from "./critic-revision.js";
import { allocateFeatureId } from "./feature-id.js";
import {
  beginFeatureStart,
  codexHooksWarning,
  endFeatureStart,
  type HostRequest,
  hostRequest,
} from "./host-prompts.js";
import {
  captureInheritedChanges,
  inheritedChangesContent,
  inheritedChangesPath,
} from "./inherited-changes.js";
import { codexMemoryGate } from "./memory-gate.js";
import {
  closedSlice,
  initialProductState,
  outcomeDigest,
  type ProductBrief,
  type ProductState,
  parseProductBrief,
  sliceDigest,
} from "./model.js";
import {
  mergeProjectRules,
  type ProjectRule,
  projectRulesMutation,
  type RuleExtractor,
  readProjectRules,
  statedRules,
} from "./project-rules.js";
import { codexRuleExtractor } from "./rule-extraction.js";
import { withProductMutation } from "./runtime.js";
import { productAuthorizationSchema } from "./scopes.js";
import {
  authorizationPath,
  json,
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
  recordMutations,
  statusMutation,
} from "./store.js";
import { productContractDigest, productSourceDigest } from "./subject.js";

export interface ProductFeatureOptions {
  readonly goal: string;
  readonly sourceBrief?: string;
  readonly riskLevel?: RiskLevel;
  readonly branch?: boolean;
}
export interface ProductFeatureOutcome {
  readonly brief: ProductBrief;
  readonly intent: Intent;
  readonly projectRules?: readonly ProjectRule[];
  readonly projectMemory?: readonly string[];
  /** Commits made after the recalled requests were given, listed with the memory. */
  readonly projectMemoryLaterChanges?: readonly string[];
  readonly branchCreated?: string;
  readonly branchWarning?: string;
  readonly redactionNotice?: string;
  readonly hostHooksWarning?: string;
  /** Uncommitted files the feature started from because Git cannot be written here. */
  readonly inheritedChanges?: readonly string[];
  readonly inheritedChangesNote?: string;
  /** The earlier feature that already records this request; no second feature was created. */
  readonly duplicateOf?: string;
  readonly duplicateNote?: string;
  /** Set by `visp feature` when its tester is writing tests in the same process, or was refused. */
  readonly testsNote?: string;
}

export async function createProductFeature(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
): Promise<Result<ProductFeatureOutcome>> {
  if (!options.goal.trim())
    return err(vispError("ARTIFACT_INVALID", "Feature goal cannot be empty"));
  // Rule and memory checks take up to 30 s; a worker whose tool returned early asked `next`,
  // was told to start a feature, and started a second one.
  await beginFeatureStart(workspace);
  try {
    return await startProductFeature(workspace, options);
  } finally {
    await endFeatureStart(workspace);
  }
}

async function startProductFeature(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
): Promise<Result<ProductFeatureOutcome>> {
  // Before the cleanliness check: the earlier feature's tester may have written its files.
  const host = await hostRequest(workspace, options.sourceBrief);
  if (!host.ok) return host;
  const raw = host.value?.request ?? options.sourceBrief ?? options.goal;
  const text = redactRequest(raw, workspace.paths.root);
  const earlier = await recentDuplicate(workspace, text, duplicateTerms(workspace, options));
  if (!earlier.ok) return earlier;
  if (earlier.value) return ok(earlier.value);
  const start = await withProductMutation(workspace, async () => {
    const foundation = await requireFeatureFoundation(workspace, "visp feature <goal>");
    if (!foundation.ok) return foundation;
    const baseline = await captureAcceptanceBaseline(workspace);
    if (!baseline.ok) return baseline;
    const inherited = await captureInheritedChanges(workspace, foundation.value.inherited);
    return inherited.ok ? ok({ baseline: baseline.value, inherited: inherited.value }) : inherited;
  });
  if (!start.ok) return start;
  const request = await featureRequest(workspace, host.value, raw, text);
  if (!request.ok) return request;
  return withProductMutation(workspace, () =>
    createProductFeatureLocked(workspace, options, request.value, start.value),
  );
}

interface FeatureStart {
  readonly baseline: AcceptanceBaseline;
  readonly inherited: Record<string, string>;
}

/** The active-feature status, and the inherited record, which is written with the feature or not at all. */
async function localStateMutations(
  workspace: WorkspaceState,
  feature: string,
  inherited: Record<string, string>,
): Promise<Result<FileMutation[]>> {
  const status = await statusMutation(workspace, feature, undefined, "feature");
  if (!status.ok) return status;
  if (Object.keys(inherited).length === 0) return ok([status.value]);
  const path = inheritedChangesPath(workspace, feature);
  const existing = await workspace.files.readTextIfExists(path);
  if (!existing.ok) return existing;
  return ok([
    status.value,
    {
      kind: "write",
      path,
      content: inheritedChangesContent(inherited),
      expectedBefore: filePrecondition(existing.value),
    },
  ]);
}

function inheritedOutcome(inherited: Record<string, string>) {
  const paths = Object.keys(inherited);
  return paths.length
    ? { inheritedChanges: paths, inheritedChangesNote: inheritedNote(paths) }
    : {};
}

function inheritedNote(paths: readonly string[]): string {
  const shown = paths.slice(0, 20).join(", ");
  const more = paths.length > 20 ? ` and ${paths.length - 20} more` : "";
  return `Git cannot be written here, so ${paths.length} uncommitted change(s) from earlier work stay uncommitted: ${shown}${more}. Keep them: they are recorded as this feature's starting point and are not attributed to it unless you change those files further. Never discard them with git checkout, restore, reset or rm. Continue with visp work.`;
}

async function createProductFeatureLocked(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
  request: FeatureRequest,
  start: FeatureStart,
): Promise<Result<ProductFeatureOutcome>> {
  const { baseline, inherited } = start;
  if (!options.goal.trim())
    return err(vispError("ARTIFACT_INVALID", "Feature goal cannot be empty"));
  // Cleanliness was checked before model/service calls, which may write their own logs.
  const foundation = await requireImplementationFoundation(workspace, "visp feature <goal>");
  if (!foundation.ok) return foundation;
  const goal = redactRequest(options.goal, workspace.paths.root);
  const allocated = await newFeatureId(
    workspace,
    request.request,
    goal,
    duplicateTerms(workspace, options),
  );
  if (!allocated.ok) return allocated;
  if ("duplicate" in allocated.value) return ok(allocated.value.duplicate);
  const feature = allocated.value.feature;
  const timestamp = new Date().toISOString();
  const { host, memory } = request;
  const rules = await featureProjectRules(workspace, request.stated, feature, timestamp);
  if (!rules.ok) return rules;
  const parsed = parseProductBrief({
    version: 2,
    feature,
    goal,
    originalRequest: request.originalRequest,
    acceptanceBaseline: baseline,
  });
  if (!parsed.ok) return parsed;
  const brief = parsed.value;
  const critic = await resolveCriticPolicy(workspace.config.harness, workspace.config.critic);
  if (!critic.ok) return critic;
  const featureMetadata = await createFeatureMetadata(workspace, brief, options, timestamp);
  const { intent, branchCreated, branchWarning } = featureMetadata;
  const local = await localStateMutations(workspace, feature, inherited);
  if (!local.ok) return local;
  const saved = await applyFileTransaction(workspace.paths.root, "create-product-feature", [
    ...recordMutations(workspace, undefined, brief, {
      ...initialProductState(brief, timestamp),
      ...criticStateFields(critic.value),
    }),
    {
      kind: "write",
      path: workspace.paths.featureFile(feature, "intent.json"),
      content: json(intent),
      expectedBefore: { existed: false },
    },
    ...local.value,
    ...(host?.mutation ? [host.mutation] : []),
    ...rules.value.mutations,
    ...memory.mutations,
    ...memoryFileMutations(workspace, feature, memory),
  ]);
  return saved.ok
    ? ok({
        brief,
        intent,
        ...rules.value.reported,
        ...memory.reported,
        redactionNotice: featureRedactionNotice(request.redacted, goal, options.goal),
        ...(branchCreated ? { branchCreated } : {}),
        ...(branchWarning ? { branchWarning } : {}),
        ...inheritedOutcome(inherited),
        ...hooksWarning(workspace, host),
      })
    : saved;
}

/** A new feature id, or the earlier feature a concurrent create of this request already made. */
async function newFeatureId(
  workspace: WorkspaceState,
  request: string,
  goal: string,
  terms: DuplicateTerms | undefined,
): Promise<Result<{ feature: string } | { duplicate: ProductFeatureOutcome }>> {
  const listed = await workspace.store.listFeatures();
  if (!listed.ok) return listed;
  // Authoritative under the lock: the check before it could not see a create in flight.
  const duplicate = await recentDuplicate(workspace, request, terms, listed.value);
  if (!duplicate.ok) return duplicate;
  if (duplicate.value) return ok({ duplicate: duplicate.value });
  const allocated = await allocateFeatureId(workspace.paths.root, listed.value, goal);
  return allocated.ok ? ok({ feature: allocated.value }) : allocated;
}

/**
 * Rules the user stated for later work in the prompts this feature consumes are recorded.
 * Work replies, the tester and the reviewer read the current rules. Only recorded user
 * prompts count, never a worker's text.
 */
async function featureProjectRules(
  workspace: WorkspaceState,
  stated: readonly string[],
  feature: string,
  capturedAt: string,
): Promise<
  Result<{
    mutations: FileMutation[];
    reported: { projectRules?: ProjectRule[] };
  }>
> {
  const recorded = await readProjectRules(workspace);
  if (!recorded.ok) return recorded;
  const merged = mergeProjectRules(recorded.value.rules, stated, feature, capturedAt);
  return ok({
    mutations: merged.added.length
      ? [projectRulesMutation(workspace, recorded.value.before, merged.rules)]
      : [],
    reported: merged.rules.length ? { projectRules: merged.rules } : {},
  });
}

/** The model of a VISP-launched Codex reviewer, which also reads rules and chooses memories. */
async function reviewerModel(workspace: WorkspaceState): Promise<string | undefined> {
  if (workspace.config.critic?.launch !== "codex-exec") return undefined;
  const critic = await resolveCriticPolicy(workspace.config.harness, workspace.config.critic);
  return critic.ok ? critic.value.config?.model : undefined;
}

/** With a VISP-launched Codex reviewer, its model reads the rules; otherwise phrase matching does. */
async function ruleReader(workspace: WorkspaceState): Promise<RuleExtractor | undefined> {
  const model = await reviewerModel(workspace);
  return model ? codexRuleExtractor({ model }) : undefined;
}

/** Candidates wide enough to hold every note of a store with about fifty. */
const GATE_CANDIDATE_TOKENS = 6000;

/**
 * Visp Memory's keyword selection alone, or, with a reviewer model and `select: model`, that
 * model choosing from a wide candidate set; keyword selection is the fallback.
 */
async function selectMemories(
  workspace: WorkspaceState,
  command: string,
  request: string,
  rules: readonly string[],
  later: readonly string[],
): Promise<string[]> {
  const model =
    workspace.config.memory.service?.select === "keyword"
      ? undefined
      : await reviewerModel(workspace);
  if (!model) return memoryBriefFor(workspace, command, request);
  const candidates = await memoryBriefFor(workspace, command, request, GATE_CANDIDATE_TOKENS);
  try {
    return await codexMemoryGate({ model })(request, candidates, rules, later);
  } catch {
    return memoryBriefFor(workspace, command, request);
  }
}

/** Visp Memory's store: earlier requests are recorded there first. */
async function serviceMemories(
  workspace: WorkspaceState,
  command: string,
  earlier: readonly EarlierFeature[],
  request: string,
  rules: readonly string[],
  later: readonly string[],
): Promise<Result<{ memories: string[]; mutation?: FileMutation }>> {
  const recorded = await recordEarlierRequests(workspace, command, earlier);
  if (!recorded.ok) return recorded;
  const memories = await selectMemories(workspace, command, request, rules, later);
  return ok({ memories, ...(recorded.value ? { mutation: recorded.value } : {}) });
}

/** VISP's own store: every recorded note goes to the reviewer's model, which passes on only what applies. */
async function recallMemories(
  workspace: WorkspaceState,
  model: string,
  earlier: readonly EarlierFeature[],
  request: string,
  rules: readonly string[],
  later: readonly string[],
): Promise<Result<{ memories: string[]; mutation?: FileMutation }>> {
  const history = await recordRequestHistory(workspace, earlier);
  if (!history.ok) return history;
  let memories: string[] = [];
  try {
    memories = await codexMemoryGate({ model })(
      request,
      notInRequest(request, history.value.notes),
      rules,
      later,
    );
  } catch {
    // Without its model, nothing is selected: every note unfiltered would be noise.
  }
  return ok({
    memories,
    ...(history.value.mutation ? { mutation: history.value.mutation } : {}),
  });
}

interface FeatureMemory {
  readonly memories: string[];
  readonly laterChanges: string[];
  readonly mutations: FileMutation[];
  readonly reported: { projectMemory?: string[]; projectMemoryLaterChanges?: string[] };
}

interface FeatureRequest {
  /** The redacted request text a duplicate is recognized by. */
  readonly request: string;
  readonly redacted: boolean;
  readonly host: HostRequest | undefined;
  readonly stated: readonly string[];
  readonly memory: FeatureMemory;
  readonly originalRequest: string;
}

/** The user's recorded request, with the decisions Visp Memory selects for it; rules are captured on the way. */
async function featureRequest(
  workspace: WorkspaceState,
  host: HostRequest | undefined,
  raw: string,
  request: string,
): Promise<Result<FeatureRequest>> {
  const recorded = await readProjectRules(workspace);
  if (!recorded.ok) return recorded;
  const stated = await statedRules(host?.prompts ?? [], await ruleReader(workspace));
  const rules = mergeProjectRules(
    recorded.value.rules,
    stated,
    "pending",
    new Date().toISOString(),
  );
  const memory = await featureMemory(
    workspace,
    request,
    rules.rules.map((rule) => rule.text),
  );
  if (!memory.ok) return memory;
  // Earlier rules are not copied into the fixed request: work replies, the reviewer and the
  // tester read the current rules, so a removed rule stops applying at once.
  return ok({
    request,
    redacted: raw !== request,
    host,
    stated,
    memory: memory.value,
    originalRequest: [request, projectMemoryText(memory.value.memories, memory.value.laterChanges)]
      .filter(Boolean)
      .join("\n\n"),
  });
}

/** A request repeated within this window, before any work on it, is the same feature. */
const DUPLICATE_WINDOW_MS = 10 * 60_000;
const DUPLICATE_MIN_REQUEST = 20;

/**
 * A worker that runs `visp feature` twice for one request (a host that returned early, a
 * retry) got two feature directories. The earlier one is returned when it records this
 * request, is under ten minutes old and has neither an execution nor a started slice; a
 * worked or accepted feature is never merged into. The tester is not started here.
 */
async function recentDuplicate(
  workspace: WorkspaceState,
  request: string,
  terms: DuplicateTerms | undefined,
  known?: readonly string[],
): Promise<Result<ProductFeatureOutcome | undefined>> {
  const wanted = whitespaceNormalized(request);
  if (!terms || wanted.length < DUPLICATE_MIN_REQUEST) return ok(undefined);
  const listed = known ? ok(known) : await workspace.store.listFeatures();
  if (!listed.ok) return listed;
  for (const id of listed.value) {
    const intent = await workspace.store.readIntent(id);
    if (!intent.ok) continue;
    const age = Date.now() - Date.parse(intent.value.createdAt);
    // Newest first: everything after this is older too.
    if (!(age <= DUPLICATE_WINDOW_MS)) break;
    if (!recordsRequest(intent.value, wanted, terms)) continue;
    const record = await readProductRecord(workspace, { feature: id });
    if (!record.ok || !untouchedFeature(record.value.state)) continue;
    return ok({
      brief: record.value.brief,
      intent: intent.value,
      duplicateOf: id,
      duplicateNote: `Feature ${id} already records this request (${Math.max(0, Math.round(age / 1000))} s ago); no second feature was started. Continue: visp work --feature ${id} --check "<test command>"`,
    });
  }
  return ok(undefined);
}

/** What else a repeat must match: a different goal or risk, or a branch, is a new feature. */
interface DuplicateTerms {
  readonly goal: string;
  readonly riskLevel: RiskLevel;
}

function duplicateTerms(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
): DuplicateTerms | undefined {
  return options.branch
    ? undefined
    : {
        goal: redactRequest(options.goal, workspace.paths.root),
        riskLevel: options.riskLevel ?? "low",
      };
}

/**
 * The request is the stored one, whole: what follows it may only be the memory block VISP
 * appended. A request that is a mere prefix of a longer one (a mid-word cut, a narrower
 * ask) is a different request.
 */
function recordsRequest(intent: Intent, wanted: string, terms: DuplicateTerms): boolean {
  if (intent.goal !== terms.goal || intent.riskLevel !== terms.riskLevel) return false;
  const stored = whitespaceNormalized(intent.sourceBrief ?? "");
  if (!stored.startsWith(wanted)) return false;
  const rest = stored.slice(wanted.length).trim();
  return (
    rest === "" ||
    (stored[wanted.length] === " " &&
      [MEMORY_HEADING, MEMORY_HEADING_WITH_LATER_CHANGES].some((heading) =>
        rest.startsWith(whitespaceNormalized(heading)),
      ))
  );
}

function untouchedFeature(state: ProductState): boolean {
  return (
    state.status === "active" &&
    state.executions.length === 0 &&
    Object.values(state.slices).every((slice) => slice.status === "pending")
  );
}

function whitespaceNormalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The decisions a feature carries, and the code changes listed with them, for its `work` replies. */
function memoryFileMutations(
  workspace: WorkspaceState,
  feature: string,
  memory: { memories: readonly string[]; laterChanges: readonly string[] },
): FileMutation[] {
  if (memory.memories.length === 0) return [];
  const { memories, laterChanges: later } = memory;
  return [
    {
      kind: "write",
      path: workspace.paths.featureFile(feature, PROJECT_MEMORY_FILE),
      content: json({ version: 1, memories, ...(later.length ? { laterChanges: later } : {}) }),
      expectedBefore: { existed: false },
    },
  ];
}

/**
 * Earlier features' requests are recorded and the decisions that constrain this request join
 * it; the feature keeps them for `work` replies. With `memory.service` Visp Memory holds them;
 * otherwise VISP does, and only with a reviewer model to choose.
 */
async function featureMemory(
  workspace: WorkspaceState,
  request: string,
  rules: readonly string[],
): Promise<Result<FeatureMemory>> {
  const none = ok({ memories: [], laterChanges: [], mutations: [], reported: {} });
  // memory.enabled switches off every memory path, the long-term store included.
  if (!workspace.config.memory.enabled) return none;
  const command = workspace.config.memory.service?.command;
  const model =
    command || !workspace.config.memory.recall ? undefined : await reviewerModel(workspace);
  if (!command && !model) return none;
  const earlier = await earlierFeatures(workspace);
  if (!earlier.ok) return earlier;
  // Code can change after a decision was recorded; the gate, the worker and the reviewer are told.
  const later = await laterChanges(workspace, earlier.value);
  const chosen = command
    ? await serviceMemories(workspace, command, earlier.value, request, rules, later)
    : await recallMemories(workspace, model as string, earlier.value, request, rules, later);
  if (!chosen.ok) return chosen;
  const { memories } = chosen.value;
  const mutations: FileMutation[] = chosen.value.mutation ? [chosen.value.mutation] : [];
  // Nothing is listed without a note to weigh against it.
  const listed = memories.length ? later : [];
  return ok({
    memories,
    laterChanges: listed,
    mutations,
    reported: {
      ...(memories.length ? { projectMemory: memories } : {}),
      ...(listed.length ? { projectMemoryLaterChanges: listed } : {}),
    },
  });
}

async function earlierFeatures(workspace: WorkspaceState): Promise<Result<EarlierFeature[]>> {
  const listed = await workspace.store.listFeatures();
  if (!listed.ok) return listed;
  const earlier: EarlierFeature[] = [];
  for (const id of listed.value) {
    const intent = await workspace.store.readIntent(id);
    if (intent.ok && intent.value.sourceBrief)
      earlier.push({
        feature: id,
        goal: intent.value.goal,
        originalRequest: intent.value.sourceBrief,
        createdAt: intent.value.createdAt,
      });
  }
  return ok(earlier);
}

function criticStateFields(critic: {
  enabled: boolean;
  manual?: boolean;
  config?: ProductState["criticDefault"];
}) {
  return {
    criticEnabled: critic.enabled,
    ...(critic.manual ? { criticManual: true } : {}),
    ...(critic.config ? { criticDefault: critic.config } : {}),
  };
}

async function createFeatureMetadata(
  workspace: WorkspaceState,
  brief: ProductBrief,
  options: ProductFeatureOptions,
  timestamp: string,
): Promise<Omit<ProductFeatureOutcome, "brief">> {
  let branchCreated: string | undefined;
  let branchWarning: string | undefined;
  if (options.branch) {
    const name = `feature/${brief.feature}`;
    const created = await createBranch(workspace.paths.root, name);
    if (created.ok) branchCreated = name;
    else branchWarning = created.error.message;
  }
  const branch = await currentBranch(workspace.paths.root);
  const intent: Intent = {
    kind: "intent",
    createdAt: timestamp,
    id: brief.feature,
    goal: brief.goal,
    sourceBrief: brief.originalRequest,
    sourceBriefHash: sha256(brief.originalRequest),
    riskLevel: options.riskLevel ?? "low",
    acceptanceBaseline: brief.acceptanceBaseline,
    ...(branch.ok && branch.value.trim() !== "HEAD" ? { branch: branch.value.trim() } : {}),
  };
  return { intent, branchCreated, branchWarning };
}

export interface ProductBriefUpdate extends ProductSelection {
  readonly brief?: unknown;
  readonly patch?: unknown;
  readonly reason?: string;
  readonly intentChange?: { readonly reason: string; readonly provenance: string };
  /** Host callbacks must not overwrite a brief changed while they were running. */
  readonly expectedBriefDigest?: string;
  readonly expectedSubjectDigest?: string;
}

/** `normalized` lists authored shapes VISP rewrote before validation; absent when none. */
export type ProductBriefUpdateResult = ProductBrief & {
  readonly normalized?: readonly string[];
  readonly authorizationRevoked?: boolean;
  readonly mayEdit?: false;
  readonly nextCommand?: string;
  readonly resetSlices?: readonly string[];
};

export function updateProductBrief(
  workspace: WorkspaceState,
  options: ProductBriefUpdate,
): Promise<Result<ProductBriefUpdateResult>> {
  return withProductMutation(workspace, () => updateProductBriefLocked(workspace, options));
}

async function updateProductBriefLocked(
  workspace: WorkspaceState,
  options: ProductBriefUpdate,
): Promise<Result<ProductBriefUpdateResult>> {
  const loaded = await readProductRecord(workspace, options, true);
  if (!loaded.ok) return loaded;
  const previous = loaded.value;
  const current = await checkHostBriefContext(workspace, previous, options);
  if (!current.ok) return current;
  const authored = authoredBrief(previous, options);
  if (!authored.ok) return authored;
  const { brief, normalized } = authored.value;
  const reported = (
    saved: ProductBrief,
    extra: Partial<ProductBriefUpdateResult> = {},
  ): ProductBriefUpdateResult => ({
    ...saved,
    ...(normalized.length ? { normalized } : {}),
    ...extra,
  });
  const digest = hashValue(brief);
  if (digest === previous.state.briefDigest && hashValue(previous.brief) === digest)
    return ok(reported(brief));
  const revision = validateRevision(previous.state, brief, options);
  if (!revision.ok) return revision;
  const subject = await productSourceDigest(workspace, previous.brief);
  if (!subject.ok) return subject;
  const state = revisedProductState(previous.state, brief, revision.value, subject.value);
  const auth = await workspace.files.readTextIfExists(authorizationPath(workspace, brief.feature));
  if (!auth.ok) return auth;
  const keepAuthorization = authorizationStillApplies(auth.value, state);
  const critic = await planCriticRevision(workspace, previous, brief, revision.value);
  if (!critic.ok) return critic;
  const resetSlices = brief.slices
    .filter(
      (slice) =>
        previous.state.slices[slice.id]?.status === "closed" &&
        state.slices[slice.id]?.status === "pending",
    )
    .map((slice) => slice.id);
  const saved = await applyFileTransaction(workspace.paths.root, "update-product-brief", [
    ...recordMutations(workspace, previous, brief, state),
    ...critic.value,
    ...(auth.value && !validAuthorization(auth.value)
      ? [
          {
            kind: "remove" as const,
            path: authorizationPath(workspace, brief.feature),
            expectedBefore: { existed: true as const, hash: sha256(auth.value) },
          },
        ]
      : []),
  ]);
  return saved.ok
    ? ok(
        reported(brief, {
          ...(auth.value && !keepAuthorization
            ? {
                authorizationRevoked: true,
                mayEdit: false,
                nextCommand: `visp work --feature ${brief.feature}`,
              }
            : {}),
          ...(resetSlices.length ? { resetSlices } : {}),
        }),
      )
    : saved;
}

/** Authored input, normalized and parsed, that keeps the record's identity and original request. */
function authoredBrief(
  previous: ProductRecord,
  options: ProductBriefUpdate,
): Result<{ brief: ProductBrief; normalized: readonly string[] }> {
  if ((options.brief === undefined) === (options.patch === undefined))
    return err(vispError("ARTIFACT_INVALID", "Supply exactly one of brief or patch"));
  const input = normalizeBriefInput(
    options.patch ?? options.brief,
    options.patch === undefined ? "brief" : "patch",
    previous.brief,
  );
  const parsed =
    options.patch === undefined
      ? parseProductBrief(input.value)
      : patchProductBrief(previous.brief, input.value);
  if (!parsed.ok) return parsed;
  if (parsed.value.feature !== previous.brief.feature)
    return err(vispError("ARTIFACT_INVALID", "A brief update cannot change the feature ID"));
  if (parsed.value.originalRequest !== previous.state.intentSnapshot.originalRequest)
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "The original request is immutable; record revised outcomes through an intent change",
      ),
    );
  return ok({ brief: parsed.value, normalized: input.normalized });
}

async function checkHostBriefContext(
  workspace: WorkspaceState,
  previous: ProductRecord,
  options: ProductBriefUpdate,
): Promise<Result<void>> {
  if (options.expectedSubjectDigest !== undefined) {
    const subject = await productSourceDigest(workspace, previous.brief);
    if (!subject.ok) return subject;
    if (subject.value !== options.expectedSubjectDigest)
      return err(
        vispError(
          "STATE_BUSY",
          "Implementation changed while the host was resolving the question; refresh context before applying its conclusion",
        ),
      );
  }
  if (
    options.expectedBriefDigest !== undefined &&
    options.expectedBriefDigest !== hashValue(previous.brief)
  )
    return err(
      vispError(
        "STATE_BUSY",
        "Brief changed while the host was resolving the question; refresh context before applying its conclusion",
      ),
    );
  return ok(undefined);
}

function protectedIntentChanged(previous: ProductState, brief: ProductBrief): boolean {
  const prior = previous.intentSnapshot;
  return (
    prior.outcomes.some(
      (outcome) =>
        hashValue(outcome) !==
        hashValue(brief.outcomes.find((entry) => entry.id === outcome.id) ?? null),
    ) ||
    prior.examples.some(
      (example) => !brief.examples.some((current) => hashValue(current) === hashValue(example)),
    ) ||
    hashValue(prior.acceptanceBaseline) !== hashValue(brief.acceptanceBaseline)
  );
}

function validateRevision(
  previous: ProductState,
  brief: ProductBrief,
  options: ProductBriefUpdate,
): Result<ProductState["revisions"][number]> {
  // Tests the independent tester pinned first do not make the worker's first brief a revision.
  const initial =
    previous.revisions.every((entry) => entry.provenance === "visp-tester") &&
    previous.intentSnapshot.outcomes.length === 0 &&
    Object.keys(previous.slices).length === 0 &&
    previous.executions.length === 0;
  if (
    protectedIntentChanged(previous, brief) &&
    (!options.intentChange?.reason.trim() || !options.intentChange.provenance.trim())
  )
    return err(
      vispError(
        "STAGE_BLOCKED",
        "Changing outcomes, examples, or pinned expectations requires an explicit intent change with reason and provenance",
        { details: { intentChangeRequired: true, provenanceIsNotAuthentication: true } },
      ),
    );
  const reason = options.intentChange?.reason ?? options.reason;
  if (!initial && !reason?.trim())
    return err(vispError("ARTIFACT_INVALID", "A method revision needs a short reason"));
  return ok({
    createdAt: new Date().toISOString(),
    reason: reason ?? "Initial interpretation",
    kind: outcomeDigest(brief) !== previous.outcomeDigest && !initial ? "intent" : "method",
    provenance: options.intentChange?.provenance ?? "agent-proposed",
    before: previous.briefDigest,
    after: hashValue(brief),
  });
}

function revisedProductState(
  previous: ProductState,
  brief: ProductBrief,
  revision: ProductState["revisions"][number],
  subjectDigest: string,
): ProductState {
  const slices: ProductState["slices"] = {};
  const resets: ProductState["sliceHistory"] = [];
  for (const slice of brief.slices) {
    const contractDigest = sliceDigest(brief, slice);
    const before = previous.slices[slice.id];
    slices[slice.id] = {
      status: before?.contractDigest === contractDigest ? before.status : "pending",
      contractDigest,
    };
    if (before && closedSlice(before.status) && slices[slice.id]?.status === "pending")
      resets.push({
        task: slice.id,
        from: before.status,
        to: "pending",
        createdAt: revision.createdAt,
        subjectDigest,
        reason: `Brief revision: ${revision.reason}`,
      });
  }
  const acceptanceApplies = previous.acceptedContract === productContractDigest(brief);
  const slicesUnchanged = Object.entries(slices).every(
    ([id, value]) => previous.slices[id]?.contractDigest === value.contractDigest,
  );
  return {
    ...previous,
    briefDigest: revision.after,
    outcomeDigest: outcomeDigest(brief),
    intentSnapshot: {
      originalRequest: previous.intentSnapshot.originalRequest,
      outcomes: brief.outcomes,
      examples: brief.examples,
      acceptanceBaseline: brief.acceptanceBaseline,
    },
    updatedAt: revision.createdAt,
    status:
      previous.status === "accepted" && acceptanceApplies && slicesUnchanged
        ? "accepted"
        : "active",
    acceptedSubject: acceptanceApplies ? previous.acceptedSubject : undefined,
    slices,
    sliceHistory: [...previous.sliceHistory, ...resets],
    revisions: [...previous.revisions, revision],
  };
}

function authorizationStillApplies(content: string | undefined, state: ProductState): boolean {
  if (!content) return false;
  try {
    const parsed = productAuthorizationSchema.safeParse(JSON.parse(content));
    return (
      parsed.success &&
      parsed.data.feature === state.feature &&
      state.slices[parsed.data.task]?.contractDigest === parsed.data.contractDigest
    );
  } catch {
    return false;
  }
}

function hooksWarning(workspace: WorkspaceState, host: HostRequest | undefined) {
  const warning = codexHooksWarning(workspace.config.harness, host);
  return warning ? { hostHooksWarning: warning } : {};
}

function featureRedactionNotice(requestChanged: boolean, goal: string, originalGoal: string) {
  return requestChanged || goal !== originalGoal
    ? "Credentials and local paths were masked before saving the request to the committed feature trail and PR text."
    : undefined;
}

function validAuthorization(content: string): boolean {
  try {
    return productAuthorizationSchema.safeParse(JSON.parse(content)).success;
  } catch {
    return false;
  }
}
