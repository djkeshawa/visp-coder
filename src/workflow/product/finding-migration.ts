import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { err, ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import {
  findingAppliesToSlice,
  legacyFindingIdentityHistory,
  outstandingFeedback,
} from "./findings.js";
import { closedSlice } from "./model.js";
import { briefPath, json, type ProductRecord, productStatePath } from "./store.js";

const findingId = z.string().regex(/^FB-[a-f0-9]{16}$/);
export const findingIdentityMigrationSchema = z
  .object({
    version: z.literal(1),
    feature: z.string().min(1),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    aliases: z.array(
      z.object({ legacyId: findingId, id: findingId, task: z.string().nullable() }).strict(),
    ),
    ambiguousResolutions: z.array(
      z
        .object({
          reviewIndex: z.number().int().nonnegative(),
          id: findingId,
          reason: z.enum(["missing-owner", "unknown-owner"]),
        })
        .strict(),
    ),
    requiredFindings: z.array(findingId),
    requiresFreshAcceptance: z.boolean(),
    reopenedSlices: z.array(z.string()),
    previousAcceptance: z
      .object({
        status: z.enum(["active", "accepted", "historical-complete"]),
        subject: z.string().optional(),
        contract: z.string().optional(),
        reviewPolicy: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
      })
      .strict(),
  })
  .strict();
export type FindingIdentityMigration = z.infer<typeof findingIdentityMigrationSchema>;

/** A report is an upgrade record, never an acceptance receipt or source of finding authority. */
export async function planFindingIdentityMigration(
  workspace: WorkspaceState,
  record: ProductRecord,
) {
  const path = workspace.paths.featureFile(record.brief.feature, "finding-identity-migration.json");
  const existing = await workspace.files.readTextIfExists(path);
  if (!existing.ok) return existing;
  const prior = parseReport(existing.value, record.brief.feature);
  if (!prior.ok) return prior;
  const history = legacyFindingIdentityHistory(record);
  if (!history.aliases.length) return ok({ mutations: [] as FileMutation[], report: undefined });
  const pending = outstandingFeedback(record).filter(
    (finding) => finding.legacyId && finding.required,
  );
  const historical = record.state.status === "historical-complete";
  const reopenedSlices = historical
    ? []
    : record.brief.slices
        .filter(
          (slice) =>
            closedSlice(record.state.slices[slice.id]?.status) &&
            pending.some((finding) => findingAppliesToSlice(finding, slice)),
        )
        .map((slice) => slice.id);
  const sourceDigest = hashValue({ brief: record.brief, reviews: record.state.reviews });
  const requiredFindings = pending.map((finding) => finding.id);
  if (
    prior.value?.sourceDigest === sourceDigest &&
    (hashValue({
      aliases: prior.value.aliases,
      ambiguousResolutions: prior.value.ambiguousResolutions,
      requiredFindings: prior.value.requiredFindings,
    }) !== hashValue({ ...history, requiredFindings }) ||
      prior.value.requiresFreshAcceptance !== pending.length > 0)
  )
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Finding migration report differs from its source history; export and inspect it before applying",
      ),
    );
  const report: FindingIdentityMigration =
    prior.value?.sourceDigest === sourceDigest
      ? prior.value
      : {
          version: 1,
          feature: record.brief.feature,
          sourceDigest,
          ...history,
          requiredFindings,
          requiresFreshAcceptance: pending.length > 0,
          reopenedSlices,
          previousAcceptance: {
            status: record.state.status,
            subject: record.state.acceptedSubject,
            contract: record.state.acceptedContract,
            reviewPolicy: record.state.acceptedReviewPolicy,
          },
        };
  const next = reopenState(record, reopenedSlices, pending.length > 0 && !historical);
  const mutations: FileMutation[] = [];
  if (next)
    mutations.push({
      kind: "write",
      path: productStatePath(workspace, record.brief.feature),
      content: json(next),
      expectedBefore: filePrecondition(record.stateText),
    });
  if (!prior.value || prior.value.sourceDigest !== sourceDigest)
    mutations.push({
      kind: "write",
      path,
      content: json(report),
      expectedBefore: filePrecondition(existing.value),
    });
  if (mutations.length) {
    // Both unchanged contract and state are inputs to the report; protect them against races.
    mutations.push({
      kind: "write",
      path: briefPath(workspace, record.brief.feature),
      content: record.briefText,
      expectedBefore: filePrecondition(record.briefText),
    });
    if (!next)
      mutations.push({
        kind: "write",
        path: productStatePath(workspace, record.brief.feature),
        content: record.stateText,
        expectedBefore: filePrecondition(record.stateText),
      });
  }
  return ok({ mutations, report });
}

function reopenState(record: ProductRecord, slices: string[], unresolved: boolean) {
  const withdraw = unresolved && record.state.status === "accepted";
  if (!withdraw && !slices.length) return undefined;
  const next = structuredClone(record.state);
  for (const task of slices) {
    const slice = next.slices[task];
    if (slice) slice.status = "pending";
  }
  if (withdraw) {
    next.status = "active";
    delete next.acceptedSubject;
    delete next.acceptedContract;
    delete next.acceptedReviewPolicy;
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

function parseReport(content: string | undefined, feature: string) {
  if (content === undefined) return ok(undefined);
  try {
    const parsed = findingIdentityMigrationSchema.safeParse(JSON.parse(content));
    if (parsed.success && parsed.data.feature === feature) return ok(parsed.data);
  } catch {
    /* Report is preserved on any validation failure. */
  }
  return err(
    vispError("ARTIFACT_INVALID", "Malformed or unsupported finding identity migration report", {
      recovery:
        "Export history with visp-migrate export before inspecting the migration report; do not replace it with an invented version.",
    }),
  );
}
