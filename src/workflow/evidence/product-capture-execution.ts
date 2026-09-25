import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { browserExecutableIdentity } from "../../core/browser-executable.js";
import { fromUnknown, vispError } from "../../core/errors.js";
import type { FileMutation } from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import { BrowserSecurityError } from "../../testing/browser-files.js";
import { browserInputIdentity } from "../../testing/browser-input-identity.js";
import {
  type BrowserJourney,
  type BrowserJourneyResult,
  browserJourneySchema,
  runBrowserJourney,
} from "../../testing/browser-journey.js";
import { BrowserUnavailableError } from "../../testing/chrome-transport.js";
import { captureBehaviorChange } from "../product/behavior-changes.js";
import {
  browserExecutionEnvironmentIdentity,
  supportedHostCaptureRecovery,
} from "../product/environment-model.js";
import type { inspectProductImages } from "../product/images.js";
import type { productObservationPlan } from "../product/observation-plan.js";
import type { ProductRecord } from "../product/store.js";
import { productContractDigest, productSourceDigest } from "../product/subject.js";
import type { WorkspaceState } from "../state.js";
import { productJourneyKey } from "./product-journey.js";
import type { ProductReviewCapture } from "./product-review.js";

export interface ProductCaptureResult {
  readonly behaviorChange?: ReturnType<typeof captureBehaviorChange>;
  readonly captures: ProductReviewCapture[];
  readonly operations: number;
  readonly status: BrowserJourneyResult["status"];
  readonly failure?: BrowserJourneyResult["failure"];
  readonly runId: string;
  readonly nextCommand: string;
  readonly images?: Awaited<ReturnType<typeof inspectProductImages>>["images"];
  readonly imageGaps?: readonly string[];
  readonly observationPlan?: ReturnType<typeof productObservationPlan>;
}

export interface PreparedProductCapture {
  readonly result: ProductCaptureResult;
  readonly state: ProductRecord["state"];
  readonly mutations: FileMutation[];
  readonly subjectDigest: string;
}

interface CaptureExecutionOptions {
  readonly journey: unknown;
  readonly task?: string;
  readonly binary?: string;
}

export const prepareProductCapture = (
  workspace: WorkspaceState,
  record: ProductRecord,
  options: CaptureExecutionOptions,
): Promise<Result<PreparedProductCapture>> =>
  withProductCapture(workspace, record, options, async (prepared) => ok(prepared));

/** Prepare genuine runner evidence; the caller publishes it with its existing state transaction. */
export async function withProductCapture<T>(
  workspace: WorkspaceState,
  record: ProductRecord,
  options: CaptureExecutionOptions,
  publish: (prepared: PreparedProductCapture) => Promise<Result<T>>,
): Promise<Result<T>> {
  const journey = browserJourneySchema.safeParse(options.journey);
  if (!journey.success)
    return err(vispError("CONFIG_INVALID", `Invalid browser journey: ${journey.error.message}`));
  if (options.task !== undefined && !record.brief.slices.some((slice) => slice.id === options.task))
    return err(
      vispError("TASK_NOT_FOUND", `${options.task} is not a slice in ${record.brief.feature}`),
    );
  const before = await productSourceDigest(workspace, record.brief);
  if (!before.ok) return before;
  const environment = await productSourceDigest(workspace, record.brief, {});
  const comparisonEnvironment = environment.ok
    ? hashValue({
        environment: environment.value,
        browser: await browserExecutableIdentity(options.binary),
      })
    : undefined;
  const directory = await mkdtemp(join(tmpdir(), "visp-capture-"));
  try {
    const result = await runBrowserJourney({
      journey: journey.data,
      directory,
      subjectDigest: before.value,
      binary: options.binary,
      projectRoot: workspace.paths.root,
      blockedPaths: workspace.config.workflow.blockedPaths,
    });
    const after = await productSourceDigest(workspace, record.brief);
    if (!after.ok) return after;
    if (after.value !== before.value)
      return err(
        vispError(
          "EVIDENCE_FAILED",
          "Product changed during capture; capture the current version again",
        ),
      );
    // Buffer temporary images before cleanup; the caller commits these bytes atomically.
    const prepared = await prepareCaptures(
      workspace,
      record,
      result,
      before.value,
      journey.data,
      options.task,
      comparisonEnvironment,
      options.binary,
    );
    return await publish(prepared);
  } catch (cause) {
    return captureFailure(cause, record, options);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function prepareCaptures(
  workspace: WorkspaceState,
  record: ProductRecord,
  result: Awaited<ReturnType<typeof runBrowserJourney>>,
  subjectDigest: string,
  journey: BrowserJourney,
  task?: string,
  comparisonEnvironment?: string,
  binary?: string,
): Promise<PreparedProductCapture> {
  const captures: ProductReviewCapture[] = [],
    mutations: FileMutation[] = [];
  for (const capture of result.captures) {
    const path = join(
      workspace.paths.featureDir(record.brief.feature),
      "captures",
      `${capture.id}.png`,
    );
    mutations.push({
      kind: "write",
      path,
      content: await readFile(capture.path),
      expectedBefore: { existed: false },
      mode: 0o600,
    });
    captures.push({
      ...capture,
      path: relative(workspace.paths.root, path).replace(/\\/g, "/"),
    });
  }
  const id = `CAPRUN-${randomUUID()}`;
  const runPath = join(
    workspace.paths.featureDir(record.brief.feature),
    "captures",
    `run-${id}.json`,
  );
  const run = {
    id,
    version: 2,
    provenance: "runner-executed",
    outcomeDigest: record.state.outcomeDigest,
    status: result.status,
    failure: result.failure
      ? {
          ...result.failure,
          input: browserInputIdentity(journey.actions[result.failure.actionIndex ?? -1]),
        }
      : undefined,
    completedInputs: journey.actions
      .slice(0, result.status === "completed" ? undefined : (result.failure?.actionIndex ?? 0))
      .flatMap((action) => {
        const input = browserInputIdentity(action);
        return input ? [input] : [];
      }),
    subjectDigest,
    contractDigest: productContractDigest(
      record.brief,
      record.brief.slices.find((slice) => slice.id === task),
    ),
    journeyDigest: hashValue(journey),
    journey,
    comparisonEnvironment,
    journeyKey: productJourneyKey(journey, task),
    task,
    createdAt: new Date().toISOString(),
    operations: result.operations,
    captures,
  };
  mutations.push({
    kind: "write",
    path: runPath,
    content: JSON.stringify(run, null, 2),
    expectedBefore: { existed: false },
  });
  const environment = await browserExecutionEnvironmentIdentity(workspace.paths.root, binary);
  return {
    subjectDigest,
    state: {
      ...record.state,
      updatedAt: new Date().toISOString(),
      browserCapability: {
        version: 1,
        environment,
        checkedAt: new Date().toISOString(),
        status: "ready",
        kind: "startup-capture",
        detail: binary
          ? "The selected browser executable started for the recorded journey; assess its operations and results separately."
          : "The configured browser started for the recorded journey; assess its operations and results separately.",
      },
      captures: [...record.state.captures, ...captures],
      captureRuns: [...record.state.captureRuns, run],
    },
    mutations,
    result: {
      captures,
      operations: result.operations.length,
      status: result.status,
      failure: result.failure,
      runId: id,
      behaviorChange: captureBehaviorChange(record, run),
      nextCommand: `visp review --feature ${record.brief.feature}${task ? ` --task ${task}` : ""}`,
    },
  };
}

function captureFailure(cause: unknown, record: ProductRecord, options: CaptureExecutionOptions) {
  if (cause instanceof BrowserSecurityError)
    return err(
      vispError("UNSUPPORTED", cause.message, {
        details: { gap: "browser-security", reviewStatus: "unavailable" },
      }),
    );
  if (cause instanceof BrowserUnavailableError) {
    const recovery = supportedHostCaptureRecovery({
      feature: record.brief.feature,
      task: options.task,
      journey: options.journey,
      binary: options.binary,
    });
    return err(
      vispError("UNSUPPORTED", cause.message, {
        recovery: recovery.message,
        details: {
          gap: "browser-unavailable",
          reviewStatus: "unavailable",
          supportedHostOption: recovery.option,
        },
      }),
    );
  }
  return err(fromUnknown(cause, "EVIDENCE_FAILED"));
}
