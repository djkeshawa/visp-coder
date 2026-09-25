import { z } from "zod";
import { fromUnknown, vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { updateProductBrief } from "./brief.js";
import {
  independentJudgments,
  independentReviewJsonSchema,
  independentReviewSchema,
  independentReviewTemplate,
} from "./independent-review.js";
import { independentSources } from "./independent-sources.js";
import { productReviewSubmissionSchema, runProductReviewRequest } from "./review-request.js";
import { independentReviewerContext, runProductReviewerHandoff } from "./reviewer-handoff.js";
import { type ProductSelection, readProductRecord } from "./store.js";

type ReviewRequest = Extract<
  Awaited<ReturnType<typeof runProductReviewerHandoff>>,
  { ok: true }
>["value"];
export const DEFAULT_HOST_FEEDBACK_TIMEOUT_MS = 120_000;

export interface ProductFeedbackHost {
  /** Supplied by the embedding host; VISP never chooses a different model. */
  readonly model: string;
  readonly review?: (
    request: ReturnType<typeof independentReviewerContext> & {
      submission: ReturnType<typeof independentReviewTemplate>;
      responseSchema: ReturnType<typeof independentReviewJsonSchema>;
    },
    options: { model: string; signal: AbortSignal; context: "fresh-preferred"; timeoutMs?: number },
  ) => Promise<unknown>;
  readonly research?: (
    request: {
      question: string;
      originalRequest: string;
      checks: readonly { id: string; command: unknown; outcomes: readonly string[] }[];
    },
    options: { model: string; signal: AbortSignal },
  ) => Promise<unknown>;
  readonly timeoutMs?: number;
}

const conclusionSchema = z
  .object({
    conclusion: z.string().trim().min(1).max(2400),
    evidence: z.array(z.string().trim().min(1)).min(1).max(12),
    implication: z.string().trim().min(1).max(2400),
    check: z.string().min(1),
  })
  .strict();

/** Execute host capabilities, consume their results and submit through the same CLI/MCP validator. No provider, model or browser is started implicitly. */
export async function runProductHostFeedback(
  workspace: WorkspaceState,
  host: ProductFeedbackHost,
  input: ProductSelection = {},
): Promise<Result<unknown>> {
  const selection = { feature: input.feature, task: input.task };
  if (!host.model.trim())
    return err(vispError("CONFIG_INVALID", "Host feedback requires the configured model identity"));
  const timeout = host.timeoutMs ?? DEFAULT_HOST_FEEDBACK_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600_000)
    return err(
      vispError("CONFIG_INVALID", "Host feedback timeout must be between 1 and 600000 ms"),
    );
  const handoff = await runProductReviewerHandoff(workspace, selection);
  if (!handoff.ok) return handoff;
  const request = handoff.value;
  const question = request.feedbackPlan.research?.question;
  if (question && host.research) {
    return consumeResearch(workspace, host, selection, request, question, timeout);
  }

  const sources = await independentSources(workspace, request.sources);
  if (!sources.ok) return sources;
  const reviewed = host.review
    ? await bounded(
        (signal) =>
          host.review?.(
            {
              ...independentReviewerContext(request),
              sources: sources.value,
              submission: independentReviewTemplate(),
              responseSchema: independentReviewJsonSchema(),
            },
            {
              model: host.model,
              signal,
              context: "fresh-preferred",
              timeoutMs: timeout,
            },
          ) as Promise<unknown>,
        timeout,
      )
    : err(
        vispError(
          "UNSUPPORTED",
          "No host reviewer adapter is available. Retrying --dispatch cannot start a reviewer. " +
            "Use visp review --handoff with a reviewer supplied by your host, or inspect visp review " +
            "and perform a current-context review. Fill visp review --template, preserve its " +
            "subjectDigest/selection, and submit via visp review --from -. Report reviewer.context " +
            "as fresh/current only when that review actually occurred; keep missing evidence unresolved.",
        ),
      );
  if (!reviewed.ok) {
    const template = request.submission;
    return runProductReviewRequest(workspace, {
      ...selection,
      ...template,
      assessments: request.outcomes.map((outcome) => ({
        outcome: outcome.id,
        status: "unavailable",
        summary: reviewed.error.message,
        evidence: [],
        expectations: [],
      })),
      coverage: [],
      reviewer: { context: "unavailable", model: host.model, reason: reviewed.error.message },
      feedback: {
        ...template.feedback,
        dimensions: template.feedback.dimensions.map((entry) => ({
          ...entry,
          status: "unavailable",
          reason: reviewed.error.message,
        })),
      },
    });
  }
  const independent = independentReviewSchema.safeParse(reviewed.value);
  const parsed = productReviewSubmissionSchema.safeParse(
    independent.success
      ? {
          ...independentJudgments(independent.data, "product", request.outcomes),
          subjectDigest: request.subjectDigest,
          selection: request.submission.selection,
        }
      : reviewed.value,
  );
  if (!parsed.success)
    return err(
      vispError(
        "ARTIFACT_INVALID",
        `Host returned an invalid review submission: ${parsed.error.message}`,
      ),
    );
  if (parsed.data.subjectDigest !== request.subjectDigest)
    return err(
      vispError(
        "EVIDENCE_FAILED",
        "Host review does not identify the supplied product; request a fresh review",
      ),
    );
  return runProductReviewRequest(workspace, {
    ...selection,
    ...parsed.data,
    reviewer: {
      ...parsed.data.reviewer,
      context: parsed.data.reviewer?.context ?? "unspecified",
      model: host.model,
    },
  });
}

async function bounded(
  run: (signal: AbortSignal) => Promise<unknown>,
  timeout: number,
): Promise<Result<unknown>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Host capability timed out; no late result will be applied"));
      }, timeout);
    });
    return ok(await Promise.race([run(controller.signal), expired]));
  } catch (cause) {
    return err(fromUnknown(cause, "COMMAND_FAILED"));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function consumeResearch(
  workspace: WorkspaceState,
  host: ProductFeedbackHost,
  selection: ProductSelection,
  request: ReviewRequest,
  question: string,
  timeout: number,
): Promise<Result<unknown>> {
  const record = await readProductRecord(workspace, selection);
  if (!record.ok) return record;
  const researched = await bounded(
    (signal) =>
      host.research?.(
        { question, originalRequest: request.originalRequest, checks: record.value.brief.checks },
        { model: host.model, signal },
      ) as Promise<unknown>,
    timeout,
  );
  if (!researched.ok) return researched;
  const conclusion = conclusionSchema.safeParse(researched.value);
  if (!conclusion.success)
    return err(
      vispError(
        "ARTIFACT_INVALID",
        `Research must identify its implementation consequence and affected check: ${conclusion.error.message}`,
      ),
    );
  const check = record.value.brief.checks.find((entry) => entry.id === conclusion.data.check);
  if (!check)
    return err(vispError("ARTIFACT_INVALID", "Research conclusion refers to an unknown check"));
  const brief = record.value.brief;
  const updated = await updateProductBrief(workspace, {
    ...selection,
    expectedBriefDigest: hashValue(brief),
    expectedSubjectDigest: request.subjectDigest,
    brief: {
      ...brief,
      uncertainties: brief.uncertainties.filter((entry) => entry !== question),
      decisions: [
        ...brief.decisions,
        {
          statement: conclusion.data.conclusion,
          rationale: question,
          evidence: conclusion.data.evidence,
          implications: [conclusion.data.implication, `Validate with ${check.id}`],
          outcomes: check.outcomes,
        },
      ],
    },
    reason: `Resolve implementation uncertainty: ${question}`,
  });
  if (!updated.ok) return updated;
  // Decision changes invalidate relevant evidence and authorization. Return to implementation, not a premature positive review.
  return ok({
    action: "implement",
    research: "consumed",
    provenance: "host-reported",
    question,
    implication: conclusion.data.implication,
    check: check.id,
    command: `visp work --feature ${brief.feature}${selection.task ? ` --task ${selection.task}` : ""}`,
  });
}
