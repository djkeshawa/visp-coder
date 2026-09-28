import { resolveCriticPolicy } from "../../config/critic-defaults.js";
import type { RiskLevel } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { applyFileTransaction, type FileMutation } from "../../core/file-transaction.js";
import { createBranch, currentBranch } from "../../core/git.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import {
  type EarlierFeature,
  memoryBriefFor,
  notInRequest,
  PROJECT_MEMORY_FILE,
  projectMemoryText,
  recordEarlierRequests,
} from "../../memory/memory-service.js";
import { recordRequestHistory } from "../../memory/request-history.js";
import type { Intent } from "../artifacts/feature.js";
import { captureAcceptanceBaseline } from "../evidence/acceptance.js";
import { requireFeatureFoundation } from "../gates/readiness.js";
import type { WorkspaceState } from "../state.js";
import { normalizeBriefInput } from "./brief-aliases.js";
import { patchProductBrief } from "./brief-patch.js";
import { planCriticRevision } from "./critic-revision.js";
import { nextFeatureId } from "./feature-id.js";
import { type HostRequest, hostRequest } from "./host-prompts.js";
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
  readonly branchCreated?: string;
  readonly branchWarning?: string;
}

export function createProductFeature(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
): Promise<Result<ProductFeatureOutcome>> {
  return withProductMutation(workspace, () => createProductFeatureLocked(workspace, options));
}

async function createProductFeatureLocked(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
): Promise<Result<ProductFeatureOutcome>> {
  if (!options.goal.trim())
    return err(vispError("ARTIFACT_INVALID", "Feature goal cannot be empty"));
  const foundation = await requireFeatureFoundation(workspace, "visp feature <goal>");
  if (!foundation.ok) return foundation;
  const listed = await workspace.store.listFeatures();
  if (!listed.ok) return listed;
  const baseline = await captureAcceptanceBaseline(workspace);
  if (!baseline.ok) return baseline;
  const feature = nextFeatureId(listed.value, options.goal);
  const timestamp = new Date().toISOString();
  const request = await featureRequest(workspace, options, feature, timestamp);
  if (!request.ok) return request;
  const { host, rules, memory } = request.value;
  const parsed = parseProductBrief({
    version: 2,
    feature,
    goal: options.goal,
    originalRequest: request.value.originalRequest,
    acceptanceBaseline: baseline.value,
  });
  if (!parsed.ok) return parsed;
  const brief = parsed.value;
  const critic = await resolveCriticPolicy(workspace.config.harness, workspace.config.critic);
  if (!critic.ok) return critic;
  const featureMetadata = await createFeatureMetadata(workspace, brief, options, timestamp);
  const { intent, branchCreated, branchWarning } = featureMetadata;
  const status = await statusMutation(workspace, feature, undefined, "feature");
  if (!status.ok) return status;
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
    status.value,
    ...(host?.mutation ? [host.mutation] : []),
    ...rules.mutations,
    ...memory.mutations,
  ]);
  return saved.ok
    ? ok({
        brief,
        intent,
        ...rules.reported,
        ...memory.reported,
        ...(branchCreated ? { branchCreated } : {}),
        ...(branchWarning ? { branchWarning } : {}),
      })
    : saved;
}

/**
 * Rules the user stated for later work in the prompts this feature consumes are recorded.
 * Work replies, the tester and the reviewer read the current rules. Only recorded user
 * prompts count, never a worker's text.
 */
async function featureProjectRules(
  workspace: WorkspaceState,
  host: HostRequest | undefined,
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
  const stated = await statedRules(host?.prompts ?? [], await ruleReader(workspace));
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
): Promise<string[]> {
  const model =
    workspace.config.memory.service?.select === "keyword"
      ? undefined
      : await reviewerModel(workspace);
  if (!model) return memoryBriefFor(workspace, command, request);
  const candidates = await memoryBriefFor(workspace, command, request, GATE_CANDIDATE_TOKENS);
  try {
    return await codexMemoryGate({ model })(request, candidates, rules);
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
): Promise<Result<{ memories: string[]; mutation?: FileMutation }>> {
  const recorded = await recordEarlierRequests(workspace, command, earlier);
  if (!recorded.ok) return recorded;
  const memories = await selectMemories(workspace, command, request, rules);
  return ok({ memories, ...(recorded.value ? { mutation: recorded.value } : {}) });
}

/** VISP's own store: every recorded note goes to the reviewer's model, which passes on only what applies. */
async function recallMemories(
  workspace: WorkspaceState,
  model: string,
  earlier: readonly EarlierFeature[],
  request: string,
  rules: readonly string[],
): Promise<Result<{ memories: string[]; mutation?: FileMutation }>> {
  const history = await recordRequestHistory(workspace, earlier);
  if (!history.ok) return history;
  let memories: string[] = [];
  try {
    memories = await codexMemoryGate({ model })(
      request,
      notInRequest(request, history.value.notes),
      rules,
    );
  } catch {
    // Without its model, nothing is selected: every note unfiltered would be noise.
  }
  return ok({
    memories,
    ...(history.value.mutation ? { mutation: history.value.mutation } : {}),
  });
}

/** The user's recorded request, with the decisions Visp Memory selects for it; rules are captured on the way. */
async function featureRequest(
  workspace: WorkspaceState,
  options: ProductFeatureOptions,
  feature: string,
  timestamp: string,
) {
  const host = await hostRequest(workspace, options.sourceBrief);
  if (!host.ok) return host;
  const rules = await featureProjectRules(workspace, host.value, feature, timestamp);
  if (!rules.ok) return rules;
  const request = host.value?.request ?? options.sourceBrief ?? options.goal;
  const memory = await featureMemory(
    workspace,
    feature,
    request,
    (rules.value.reported.projectRules ?? []).map((rule) => rule.text),
  );
  if (!memory.ok) return memory;
  // Earlier rules are not copied into the fixed request: work replies, the reviewer and the
  // tester read the current rules, so a removed rule stops applying at once.
  return ok({
    host: host.value,
    rules: rules.value,
    memory: memory.value,
    originalRequest: [request, projectMemoryText(memory.value.memories)]
      .filter(Boolean)
      .join("\n\n"),
  });
}

/**
 * Earlier features' requests are recorded and the decisions that constrain this request join
 * it; the feature keeps them for `work` replies. With `memory.service` Visp Memory holds them;
 * otherwise VISP does, and only with a reviewer model to choose.
 */
async function featureMemory(
  workspace: WorkspaceState,
  feature: string,
  request: string,
  rules: readonly string[],
): Promise<
  Result<{
    memories: string[];
    mutations: FileMutation[];
    reported: { projectMemory?: string[] };
  }>
> {
  const none = ok({ memories: [], mutations: [], reported: {} });
  // memory.enabled switches off every memory path, the long-term store included.
  if (!workspace.config.memory.enabled) return none;
  const command = workspace.config.memory.service?.command;
  const model =
    command || !workspace.config.memory.recall ? undefined : await reviewerModel(workspace);
  if (!command && !model) return none;
  const earlier = await earlierFeatures(workspace);
  if (!earlier.ok) return earlier;
  const chosen = command
    ? await serviceMemories(workspace, command, earlier.value, request, rules)
    : await recallMemories(workspace, model as string, earlier.value, request, rules);
  if (!chosen.ok) return chosen;
  const { memories } = chosen.value;
  const mutations: FileMutation[] = chosen.value.mutation ? [chosen.value.mutation] : [];
  if (memories.length)
    mutations.push({
      kind: "write",
      path: workspace.paths.featureFile(feature, PROJECT_MEMORY_FILE),
      content: json({ version: 1, memories }),
      expectedBefore: { existed: false },
    });
  return ok({ memories, mutations, reported: memories.length ? { projectMemory: memories } : {} });
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

function validAuthorization(content: string): boolean {
  try {
    return productAuthorizationSchema.safeParse(JSON.parse(content)).success;
  } catch {
    return false;
  }
}
