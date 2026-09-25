import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { applyFileTransaction, filePrecondition } from "../../core/file-transaction.js";
import { sha256 } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import { productReviewReceipt } from "../product-presentation.js";
import type { WorkspaceState } from "../state.js";
import { experimentRecoverySuggestions } from "./experiments.js";
import { independentReviewJsonSchema, independentReviewTemplate } from "./independent-review.js";
import { independentSources } from "./independent-sources.js";
import { runProductReview } from "./review.js";
import { deliveredReviewEvidenceIds } from "./review-context.js";
import { type ProductReviewRequest, parseReviewSubmission } from "./review-request.js";
import { reviewSelectionSchema } from "./review-selection.js";
import { independentReviewerContext, productReviewerContext } from "./reviewer-handoff.js";
import { withProductMutation } from "./runtime.js";
import { json, type ProductRecord, readProductRecord } from "./store.js";

export { reviewJudgmentsSchema } from "./review-request.js";

const sessionSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    selection: reviewSelectionSchema,
    reviewMode: z.enum(["current", "observation-preview"]),
    evidenceIds: z.array(z.string()),
    images: z.array(
      z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    ),
  })
  .strict();

/** Sessions contain generated identity; reviewers author judgments only. */
export function prepareReviewSession(
  workspace: WorkspaceState,
  options: ProductReviewRequest,
): Promise<Result<unknown>> {
  return withProductMutation(workspace, async () => {
    const record = await readProductRecord(workspace, options);
    if (!record.ok) return record;
    if (record.value.state.status === "historical-complete")
      return err(vispError("STAGE_BLOCKED", "Historical reviews are read-only"));
    const reviewed = await runProductReview(workspace, options);
    if (!reviewed.ok) return reviewed;
    const bundle = reviewed.value;
    const sources = await independentSources(workspace, bundle.sources);
    if (!sources.ok) return sources;
    const id = randomUUID();
    const directory = join(workspace.paths.featureDir(bundle.feature), "review-sessions", id);
    const packetPath = join(directory, "packet.json");
    const responsePath = join(directory, "response.json");
    const images = bundle.images.map((image) => {
      const { data, ...metadata } = image;
      const path = join(
        directory,
        "images",
        `${image.sha256}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png"}`,
      );
      return {
        path,
        data,
        sha256: image.sha256,
        metadata: { ...metadata, sourcePath: image.path, path },
      };
    });
    const session = {
      version: 1,
      images: images.map(({ path, sha256 }) => ({ path, sha256 })),
      id,
      selection: bundle.selection,
      reviewMode: workspace.config.workflow.reviewMode,
      evidenceIds: deliveredReviewEvidenceIds(bundle.evidence, bundle.interactionEvidence),
    };
    const saved = await applyFileTransaction(workspace.paths.root, "prepare-review-session", [
      ...[...new Map(images.map((image) => [image.path, image])).values()].map((image) => ({
        kind: "write" as const,
        path: image.path,
        content: Buffer.from(image.data, "base64"),
        expectedBefore: { existed: false as const },
      })),
      {
        kind: "write",
        path: workspace.paths.featureFile(bundle.feature, "brief.yaml"),
        content: record.value.briefText,
        expectedBefore: filePrecondition(record.value.briefText),
      },
      {
        kind: "write",
        path: join(directory, "session.json"),
        content: json(session),
        expectedBefore: { existed: false },
      },
      {
        kind: "write",
        path: packetPath,
        content: json({
          ...independentReviewerContext(productReviewerContext(bundle)),
          sources: sources.value,
          question:
            "Does the implementation fulfill the original request? Identify consequential observed problems and uncertainty.",
          images: images.map((image) => image.metadata),
          submission: independentReviewTemplate(),
          responseSchema: independentReviewJsonSchema(session.evidenceIds),
        }),
        expectedBefore: { existed: false },
      },
    ]);
    return saved.ok
      ? ok({
          session: id,
          feature: bundle.feature,
          task: bundle.task,
          packetPath,
          responsePath,
          recovery: experimentRecoverySuggestions(
            record.value,
            bundle.subjectDigest,
            record.value.brief.slices.find((slice) => slice.id === bundle.task),
            {
              entries: [...bundle.evidence],
              sources: [...bundle.sources],
              sourceClaims: bundle.sourceClaims,
              aliases: new Map(),
            },
          ),
          command: `visp review --feature ${bundle.feature}${bundle.task ? ` --task ${bundle.task}` : ""} --session ${id} --from -`,
          instructions:
            "Read packet.json and its actual images, then complete its submission object without adding subjectDigest, selection or captures. VISP supplies identity. Submit through stdin or responsePath. A configured critic's submitted assessment is already a product review; no duplicate worker approval is needed. A prepared session is not a review or proof of image inspection.",
        })
      : saved;
  });
}

export async function submitReviewSession(
  workspace: WorkspaceState,
  options: ProductReviewRequest,
): Promise<Result<unknown>> {
  const judgments = parseReviewSubmission(
    {
      assessments: options.assessments,
      coverage: options.coverage,
      reviewer: options.reviewer,
      feedback: options.feedback,
      experimentResolutions: options.experimentResolutions,
    },
    options.session,
  );
  if (!judgments.ok) return judgments;
  options = { ...options, ...judgments.value };
  return withProductMutation(workspace, async () => {
    if (!z.string().uuid().safeParse(options.session).success)
      return err(vispError("ARTIFACT_INVALID", "Invalid review session ID"));
    const record = await readProductRecord(workspace, options);
    if (!record.ok) return record;
    const loaded = await readReviewSession(
      workspace,
      record.value.brief.feature,
      options.session as string,
    );
    if (!loaded.ok) return loaded;
    const session = loaded.value;
    const bound = validateSessionBinding(workspace, record.value, session, options.task);
    if (!bound.ok) return bound;
    const evidence = await validateSessionEvidence(workspace, session, judgments.value);
    if (!evidence.ok) return evidence;
    const result = await runProductReview(workspace, {
      ...options,
      task: session.selection.task,
      subjectDigest: session.selection.subjectDigest,
      selection: session.selection,
      reviewer: {
        context: "unspecified",
        ...(options.reviewer as object | undefined),
        session: session.id,
      },
    });
    return result.ok
      ? ok(options.detail ? result.value : productReviewReceipt(result.value))
      : result;
  });
}

function validateSessionBinding(
  workspace: WorkspaceState,
  record: ProductRecord,
  session: z.infer<typeof sessionSchema>,
  task: string | undefined,
): Result<void> {
  if (session.reviewMode !== workspace.config.workflow.reviewMode)
    return err(
      vispError(
        "EVIDENCE_FAILED",
        "Review mode changed; prepare a new session so its instructions and provenance agree",
      ),
    );
  if (
    session.selection.feature !== record.brief.feature ||
    (task !== undefined && session.selection.task !== task)
  )
    return err(vispError("ARTIFACT_INVALID", "Review session belongs to another selection"));
  if (record.state.reviews.some((review) => review.reviewer?.session === session.id))
    return err(
      vispError(
        "STATE_BUSY",
        "Review session already submitted; read the recorded review instead of replaying it",
      ),
    );
  return ok(undefined);
}

async function readReviewSession(workspace: WorkspaceState, feature: string, id: string) {
  const directory = join(workspace.paths.featureDir(feature), "review-sessions", id);
  const content = await workspace.files.readText(join(directory, "session.json"));
  if (!content.ok) return content;
  let input: unknown;
  try {
    input = JSON.parse(content.value);
  } catch {
    return err(vispError("ARTIFACT_INVALID", "Malformed review session"));
  }
  const parsed = sessionSchema.safeParse(input);
  if (!parsed.success || parsed.data.id !== id)
    return err(vispError("ARTIFACT_INVALID", "Malformed review session"));
  const confined = parsed.data.images.every((image) =>
    ["jpg", "webp", "png"].some(
      (extension) => image.path === join(directory, "images", `${image.sha256}.${extension}`),
    ),
  );
  return confined
    ? ok(parsed.data)
    : err(
        vispError(
          "ARTIFACT_INVALID",
          "Review session image paths must remain in its prepared image directory",
        ),
      );
}

async function validateSessionEvidence(
  workspace: WorkspaceState,
  session: z.infer<typeof sessionSchema>,
  judgments: unknown,
): Promise<Result<void>> {
  for (const image of session.images) {
    const bytes = await workspace.files.readBytes(image.path);
    if (!bytes.ok || sha256(bytes.value) !== image.sha256)
      return err(
        vispError(
          "EVIDENCE_FAILED",
          "Prepared review image is missing or altered; prepare a new session without rebinding the old assessment",
        ),
      );
  }
  const delivered = new Set(session.evidenceIds);
  const missing = new Set<string>();
  JSON.stringify(judgments, (key, value) => {
    if (key === "evidence" && Array.isArray(value))
      for (const id of value) if (!delivered.has(id)) missing.add(id);
    return value;
  });
  if (missing.size)
    return err(
      vispError(
        "EVIDENCE_FAILED",
        `Evidence outside this review session: ${[...missing].join(", ")}`,
        {
          recovery:
            "Prepare a new session selecting the relevant image groups; existing captures need not be rerun unless their product inputs changed.",
        },
      ),
    );
  return ok(undefined);
}
