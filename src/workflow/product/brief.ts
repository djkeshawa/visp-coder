import { resolveCriticPolicy } from "../../config/critic-defaults.js";
import type { RiskLevel } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { applyFileTransaction, filePrecondition } from "../../core/file-transaction.js";
import { createBranch, currentBranch } from "../../core/git.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { Intent } from "../artifacts/feature.js";
import { captureAcceptanceBaseline } from "../evidence/acceptance.js";
import { requireFeatureFoundation } from "../gates/readiness.js";
import type { WorkspaceState } from "../state.js";
import { normalizeBriefInput } from "./brief-aliases.js";
import { patchProductBrief } from "./brief-patch.js";
import { planCriticRevision } from "./critic-revision.js";
import { nextFeatureId } from "./feature-id.js";
import { hostRequest } from "./host-prompts.js";
import {
  initialProductState,
  outcomeDigest,
  type ProductBrief,
  type ProductState,
  parseProductBrief,
  sliceDigest,
} from "./model.js";
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
  const host = await hostRequest(workspace, options.sourceBrief);
  if (!host.ok) return host;
  const feature = nextFeatureId(listed.value, options.goal);
  const timestamp = new Date().toISOString();
  const parsed = parseProductBrief({
    version: 2,
    feature,
    goal: options.goal,
    originalRequest: host.value?.request ?? options.sourceBrief ?? options.goal,
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
    ...(host.value?.mutation ? [host.value.mutation] : []),
  ]);
  return saved.ok
    ? ok({
        brief,
        intent,
        ...(branchCreated ? { branchCreated } : {}),
        ...(branchWarning ? { branchWarning } : {}),
      })
    : saved;
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
export type ProductBriefUpdateResult = ProductBrief & { readonly normalized?: readonly string[] };

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
  const reported = (saved: ProductBrief): ProductBriefUpdateResult =>
    normalized.length ? { ...saved, normalized } : saved;
  const digest = hashValue(brief);
  if (digest === previous.state.briefDigest && hashValue(previous.brief) === digest)
    return ok(reported(brief));
  const revision = validateRevision(previous.state, brief, options);
  if (!revision.ok) return revision;
  const state = revisedProductState(previous.state, brief, revision.value);
  const auth = await workspace.files.readTextIfExists(authorizationPath(workspace, brief.feature));
  if (!auth.ok) return auth;
  const keepAuthorization = authorizationStillApplies(auth.value, state);
  const critic = await planCriticRevision(workspace, previous, brief, revision.value);
  if (!critic.ok) return critic;
  const saved = await applyFileTransaction(workspace.paths.root, "update-product-brief", [
    ...recordMutations(workspace, previous, brief, state),
    ...critic.value,
    ...(auth.value && !keepAuthorization
      ? [
          {
            kind: "remove" as const,
            path: authorizationPath(workspace, brief.feature),
            expectedBefore: filePrecondition(auth.value),
          },
        ]
      : []),
  ]);
  return saved.ok ? ok(reported(brief)) : saved;
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
): ProductState {
  const slices: ProductState["slices"] = {};
  for (const slice of brief.slices) {
    const contractDigest = sliceDigest(brief, slice);
    const before = previous.slices[slice.id];
    slices[slice.id] = {
      status: before?.contractDigest === contractDigest ? before.status : "pending",
      contractDigest,
    };
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
