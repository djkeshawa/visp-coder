import { vispError } from "../../core/errors.js";
import { filePrecondition } from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import { requireImplementationFoundation } from "../gates/readiness.js";
import type { WorkspaceState } from "../state.js";
import { updateProductBrief } from "./brief.js";
import { validateProductCheckCommand } from "./check-command.js";
import { buildProductContext } from "./context.js";
import type { ProductWorkContext } from "./context-types.js";
import { correctionReasons } from "./corrections.js";
import { requireNoPendingCriticReview } from "./critic-policy.js";
import { criticUnderstanding } from "./critic-understanding.js";
import { prepareWorkEnvironment } from "./environment.js";
import { independentTestsBeforeWork, type TestsStarter } from "./independent-tests.js";
import {
  checksFor,
  closedSlice,
  type ProductSlice,
  type ProductState,
  sliceDigest,
} from "./model.js";
import { withProductMutation } from "./runtime.js";
import {
  type ProductAuthorization,
  readProductAuthorization,
  selectProductSlice,
} from "./scopes.js";
import { runProductNext } from "./status.js";
import {
  authorizationPath,
  json,
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
  saveProductState,
  statusMutation,
} from "./store.js";
import { productSourceDigest, productSourceSnapshot } from "./subject.js";

export type { ProductWorkContext } from "./context-types.js";

export async function runProductContext(
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductWorkContext>> {
  const record = await readProductRecord(workspace, options);
  if (!record.ok) return record;
  const selected = selectProductSlice(workspace, record.value, options, true);
  if (!selected.ok) return selected;
  if (!selected.value)
    return err(
      vispError("NO_ACTIVE_TASK", "Add the next usable slice to the brief", {
        recovery: "visp brief",
      }),
    );
  const snapshot = await productSourceSnapshot(workspace, record.value.brief);
  if (!snapshot.ok) return snapshot;
  const auth = await readProductAuthorization(workspace, record.value);
  if (!auth.ok) return auth;
  return buildProductContext(
    workspace,
    record.value,
    selected.value,
    snapshot.value,
    auth.value?.task === selected.value.id,
    false,
  );
}

export interface ProductWorkOptions extends ProductSelection {
  /** A check command: on a feature without slices, work the whole request as one slice. */
  readonly check?: string;
}

export async function runProductWork(
  workspace: WorkspaceState,
  options: ProductWorkOptions = {},
  tests?: TestsStarter,
  testsWaitMs = 0,
): Promise<Result<ProductWorkContext>> {
  if (options.check?.trim()) {
    const quick = await singleSliceBrief(workspace, options.feature, options.check.trim());
    if (!quick.ok) return quick;
  }
  const independent = await independentTestsBeforeWork(
    workspace,
    options.feature,
    tests,
    testsWaitMs,
  );
  if (!independent.ok) return independent;
  const worked = await runWorkAndReviewRoute(workspace, options);
  return worked.ok && independent.value
    ? ok({ ...worked.value, independentTests: independent.value })
    : worked;
}

/**
 * The light path. Weak workers spent about six minutes reading the planning guide and
 * authoring multi-slice briefs before their first check, while the same small change
 * took bare coding two to three minutes. One slice covering the request, with the
 * worker's own test command, keeps the tester, reviewer, scope and hooks.
 */
async function singleSliceBrief(
  workspace: WorkspaceState,
  feature: string | undefined,
  check: string,
): Promise<Result<void>> {
  const record = await readProductRecord(workspace, feature ? { feature } : {});
  if (!record.ok) return record;
  const { brief } = record.value;
  if (brief.slices.length) {
    const open = brief.slices.find((slice) => !slice.checks.length);
    if (!open) return ok(undefined);
    const id = `${open.id}-C1`;
    const added = await updateProductBrief(workspace, {
      feature: brief.feature,
      reason: "Declare the slice check",
      patch: {
        checks: [{ id, command: check, outcomes: open.outcomes }],
        slices: [{ id: open.id, checks: [id] }],
      },
    });
    return added.ok ? ok(undefined) : added;
  }
  const created = await updateProductBrief(workspace, {
    feature: brief.feature,
    reason: "Work the whole request as one slice",
    patch: {
      outcomes: [
        {
          id: "O001",
          kind: "functional",
          statement: `The original request is fulfilled: ${brief.goal}`,
          priority: "must",
          provenance: "user-stated",
        },
      ],
      checks: [{ id: "C001", command: check, outcomes: ["O001"] }],
      slices: [
        {
          id: "T001",
          goal: "Deliver the original request",
          outcomes: ["O001"],
          scope: { allowed: ["**"] },
          checks: ["C001"],
        },
      ],
    },
  });
  return created.ok ? ok(undefined) : created;
}

/**
 * Work authorization mutates state; review routing must read the committed
 * state afterwards so a critic checkpoint cannot re-enter the state lock.
 */
async function runWorkAndReviewRoute(
  workspace: WorkspaceState,
  options: ProductSelection,
): Promise<Result<ProductWorkContext>> {
  const worked = await withProductMutation(workspace, () =>
    runProductWorkLocked(workspace, options),
  );
  if (!worked.ok) return worked;
  const next = await runProductNext(workspace, {
    feature: worked.value.feature,
    task: worked.value.task,
  });
  return next.ok && next.value.criticAdvice
    ? ok({ ...worked.value, criticAdvice: next.value.criticAdvice })
    : worked;
}

async function runProductWorkLocked(
  workspace: WorkspaceState,
  options: ProductSelection,
): Promise<Result<ProductWorkContext>> {
  const record = await readProductRecord(workspace, options);
  if (!record.ok) return record;
  const selected = readyProductSlice(workspace, record.value, options);
  if (!selected.ok) return selected;
  const slice = selected.value;
  const editable = await requireNoPendingCriticReview(
    workspace,
    record.value.brief.feature,
    "Submit the pending reviewer result or wait for its deadline before retrying",
  );
  if (!editable.ok) return editable;
  const foundation = await requireImplementationFoundation(
    workspace,
    `visp work --task ${slice.id}`,
  );
  if (!foundation.ok) return foundation;
  const snapshot = await productSourceSnapshot(workspace, record.value.brief);
  if (!snapshot.ok) return snapshot;
  const subject = await productSourceDigest(workspace, record.value.brief, snapshot.value);
  if (!subject.ok) return subject;
  const reopen = closedSlice(record.value.state.slices[slice.id]?.status);
  const findings = correctionReasons(record.value, slice, subject.value);
  const reopenError = reopeningGap(slice, reopen, options.task, findings);
  if (reopenError) return err(vispError("STAGE_BLOCKED", reopenError));
  const prepared = await prepareWorkEnvironment(
    workspace,
    record.value,
    slice,
    options.retryEnvironment,
  );
  if (!prepared.ok) return prepared;
  const current = prepared.value;
  const understanding = await workUnderstanding(workspace, record.value, current, slice);
  if (!understanding.ok) return understanding;
  const context = await buildProductContext(workspace, current, slice, snapshot.value, true, true);
  if (!context.ok) return context;
  const path = authorizationPath(workspace, record.value.brief.feature);
  const before = await workspace.files.readTextIfExists(path);
  if (!before.ok) return before;
  const prior = await readProductAuthorization(workspace, record.value);
  if (!prior.ok) return prior;
  const timestamp = new Date().toISOString();
  const auth: ProductAuthorization = {
    version: 2,
    feature: record.value.brief.feature,
    task: slice.id,
    createdAt: timestamp,
    root: hashValue(workspace.paths.root),
    contractDigest: sliceDigest(record.value.brief, slice),
    baseline: prior.value?.task === slice.id ? prior.value.baseline : snapshot.value,
  };
  const status = await statusMutation(workspace, record.value.brief.feature, slice.id, "work");
  if (!status.ok) return status;
  const next = workingState(current, slice, auth, timestamp, reopen, subject.value, findings);
  const saved = await saveProductState(workspace, record.value, next, [
    { kind: "write", path, content: json(auth), expectedBefore: filePrecondition(before.value) },
    status.value,
  ]);
  return saved.ok
    ? ok({
        ...context.value,
        criticUnderstanding: understanding.value,
      })
    : saved;
}

async function workUnderstanding(
  workspace: WorkspaceState,
  before: ProductRecord,
  current: ProductRecord,
  slice: ProductSlice,
) {
  const understanding = await criticUnderstanding(workspace, {
    feature: before.brief.feature,
    task: slice.id,
  });
  if (understanding.ok || current.state === before.state) return understanding;
  // Retain a recovered browser capability if stored critic state cannot be read.
  const saved = await saveProductState(workspace, before, current.state);
  return saved.ok ? understanding : saved;
}

function reopeningGap(
  slice: ProductSlice,
  reopen: boolean,
  task: string | undefined,
  findings: string[],
) {
  return reopeningBlocked(reopen, task, findings)
    ? `${slice.id} is already closed; reopening requires an explicit slice with a current product failure attributed to this slice`
    : undefined;
}

function readyProductSlice(
  workspace: WorkspaceState,
  record: ProductRecord,
  options: ProductSelection,
): Result<ProductSlice> {
  const selected = selectProductSlice(workspace, record, options, true);
  if (!selected.ok) return selected;
  const slice = selected.value;
  if (record.brief.incomplete)
    return err(
      vispError("STAGE_BLOCKED", "Complete the migrated draft brief before authorization", {
        recovery: "visp brief",
      }),
    );
  if (!slice)
    return err(
      vispError("NO_ACTIVE_TASK", "No ready slice; define the next usable behavior in the brief", {
        recovery: "visp brief",
      }),
    );
  const ready = validateReadySlice(record, slice);
  return ready.ok ? ok(slice) : ready;
}

function workingState(
  record: ProductRecord,
  slice: ProductSlice,
  auth: ProductAuthorization,
  timestamp: string,
  reopen: boolean,
  subject: string,
  findings: string[],
): ProductState {
  return {
    ...record.state,
    updatedAt: timestamp,
    ...(reopen
      ? {
          status: "active" as const,
          acceptedSubject: undefined,
          sliceHistory: [
            ...record.state.sliceHistory,
            {
              task: slice.id,
              from: record.state.slices[slice.id]?.status ?? "closed",
              to: "in-progress",
              createdAt: timestamp,
              subjectDigest: subject,
              reason: `Reopened to correct current mandatory findings: ${findings.join(", ")}`,
            },
          ],
        }
      : {}),
    slices: {
      ...record.state.slices,
      [slice.id]: { status: "in-progress" as const, contractDigest: auth.contractDigest },
    },
  };
}

/**
 * Functional outcomes need executed evidence; quality and experience can rest on review.
 * An outcome another slice's check already exercises is covered.
 */
function promisesBehavior(record: ProductRecord, slice: ProductSlice): boolean {
  const checked = new Set(record.brief.checks.flatMap((check) => check.outcomes));
  return record.brief.outcomes.some(
    (outcome) =>
      slice.outcomes.includes(outcome.id) &&
      outcome.kind === "functional" &&
      !checked.has(outcome.id),
  );
}

/** Without a runnable check, `done` has nothing to execute and the critic has no evidence. */
function missingCheck(slice: ProductSlice) {
  const id = `${slice.id}-C1`;
  const patch = {
    checks: [{ id, command: ["<test runner>", "<test file>"], outcomes: slice.outcomes }],
    slices: [{ id: slice.id, checks: [id] }],
  };
  return vispError(
    "STAGE_BLOCKED",
    `${slice.id} has no runnable check. Declare the command that exercises this slice (your test runner or a browser journey) before editing.`,
    {
      recovery: `visp brief --patch - --reason "Add the slice check" with ${JSON.stringify(patch)}, then run visp work again`,
    },
  );
}

function validateReadySlice(record: ProductRecord, slice: ProductSlice): Result<void> {
  if (!slice.scope.allowed.length || !slice.outcomes.length)
    return err(
      vispError("STAGE_BLOCKED", "A slice needs an observable outcome and bounded write scope", {
        recovery: "visp brief",
      }),
    );
  const checks = checksFor(record.brief, slice);
  if (!checks.length && promisesBehavior(record, slice)) return err(missingCheck(slice));
  for (const check of checks) {
    const valid = validateProductCheckCommand(check);
    if (!valid.ok) return valid;
  }
  const dependencies = slice.dependsOn.filter(
    (id) => !closedSlice(record.state.slices[id]?.status),
  );
  return dependencies.length
    ? err(vispError("STAGE_BLOCKED", `${slice.id} depends on ${dependencies.join(", ")}`))
    : ok(undefined);
}

function reopeningBlocked(
  reopen: boolean,
  explicitTask: string | undefined,
  findings: string[],
): boolean {
  return reopen && (explicitTask === undefined || findings.length === 0);
}
