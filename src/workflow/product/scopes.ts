import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { matchesAny } from "../../core/patterns.js";
import { err, ok, type Result } from "../../core/result.js";
import type { ImplementMarker } from "../artifacts/evidence.js";
import type { ScopeOptions, WorkspaceState } from "../state.js";
import { closedSlice, type ProductBrief, type ProductSlice, sliceDigest } from "./model.js";
import {
  authorizationPath,
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
} from "./store.js";
import { productSourceSnapshot } from "./subject.js";

export const productAuthorizationSchema = z
  .object({
    version: z.literal(2),
    feature: z.string(),
    task: z.string(),
    createdAt: z.string(),
    root: z.string(),
    contractDigest: z.string(),
    baseline: z.record(z.string()),
  })
  .strict();
export type ProductAuthorization = z.infer<typeof productAuthorizationSchema>;

export function selectProductSlice(
  workspace: WorkspaceState,
  record: ProductRecord,
  options: ProductSelection,
  chooseNext = false,
): Result<ProductSlice | undefined> {
  const requested =
    options.task ??
    (workspace.status?.activeFeature === record.brief.feature
      ? workspace.status?.activeTask
      : undefined);
  if (requested !== undefined) {
    const slice = record.brief.slices.find((entry) => entry.id === requested);
    if (!slice)
      return err(
        vispError("TASK_NOT_FOUND", `${requested} is not a slice in ${record.brief.feature}`, {
          recovery: `visp status --feature ${record.brief.feature}`,
        }),
      );
    if (
      options.task !== undefined ||
      !chooseNext ||
      !closedSlice(record.state.slices[slice.id]?.status)
    )
      return ok(slice);
  }
  return ok(
    chooseNext
      ? record.brief.slices.find(
          (slice) =>
            !closedSlice(record.state.slices[slice.id]?.status) &&
            slice.dependsOn.every((id) => closedSlice(record.state.slices[id]?.status)),
        )
      : undefined,
  );
}

export function markerForProduct(
  brief: ProductBrief,
  slice: ProductSlice,
  createdAt: string,
): ImplementMarker {
  return {
    kind: "implement-marker",
    createdAt,
    feature: brief.feature,
    task: slice.id,
    allowedFiles: slice.scope.allowed,
    expectedFiles: slice.scope.expected,
    forbiddenFiles: slice.scope.forbidden,
    contractHash: sliceDigest(brief, slice),
  };
}

export async function readProductAuthorization(
  workspace: WorkspaceState,
  record: ProductRecord,
): Promise<Result<ProductAuthorization | undefined>> {
  const content = await workspace.files.readTextIfExists(
    authorizationPath(workspace, record.brief.feature),
  );
  if (!content.ok || content.value === undefined) return content.ok ? ok(undefined) : content;
  let input: unknown;
  try {
    input = JSON.parse(content.value);
  } catch {
    return err(vispError("ARTIFACT_INVALID", "Invalid product authorization"));
  }
  const parsed = productAuthorizationSchema.safeParse(input);
  if (!parsed.success) return err(vispError("ARTIFACT_INVALID", "Invalid product authorization"));
  const auth = parsed.data;
  const slice = record.brief.slices.find((entry) => entry.id === auth.task);
  // Old markers and copied worktree markers never grant current authorization.
  if (
    !slice ||
    closedSlice(record.state.slices[auth.task]?.status) ||
    auth.feature !== record.brief.feature ||
    auth.root !== hashValue(workspace.paths.root) ||
    auth.contractDigest !== sliceDigest(record.brief, slice)
  )
    return ok(undefined);
  return ok(auth);
}

export async function productScopes(
  workspace: WorkspaceState,
  options: ScopeOptions = {},
): Promise<Result<ImplementMarker[]>> {
  const record = await readProductRecord(workspace, options);
  if (!record.ok) return record.error.code === "NO_ACTIVE_FEATURE" ? ok([]) : record;
  const { brief, state } = record.value;
  if (options.source === "tasks")
    return ok(brief.slices.map((slice) => markerForProduct(brief, slice, state.createdAt)));
  const auth = await readProductAuthorization(workspace, record.value);
  if (!auth.ok) return auth;
  return ok(
    brief.slices
      .filter(
        (slice) =>
          auth.value?.task === slice.id ||
          (options.includeDone && closedSlice(state.slices[slice.id]?.status)),
      )
      .map((slice) => markerForProduct(brief, slice, auth.value?.createdAt ?? state.createdAt)),
  );
}

/** Enforce the active grant against content changes since authorization. */
export async function checkProductScope(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
): Promise<Result<void>> {
  const auth = await readProductAuthorization(workspace, record);
  if (!auth.ok) return auth;
  if (!auth.value || auth.value.task !== slice.id)
    return err(
      vispError("STAGE_BLOCKED", `No current authorization for ${slice.id}`, {
        recovery: `visp work --task ${slice.id}`,
      }),
    );
  const current = await productSourceSnapshot(workspace, record.brief);
  if (!current.ok) return current;
  const pinned = new Set(
    record.brief.acceptanceBaseline.flatMap((entry) => entry.files.map((file) => file.path)),
  );
  const paths = [...new Set([...Object.keys(current.value), ...Object.keys(auth.value.baseline)])]
    .filter((path) => current.value[path] !== auth.value?.baseline[path])
    // Pinned acceptance files are VISP's, may be pinned mid-slice, and are hash-checked.
    .filter((path) => !pinned.has(path));
  // The baseline already preserves prior slices and user changes. New changes need this grant.
  const scopes = [slice];
  const forbidden = paths.filter(
    (path) =>
      matchesAny(path, workspace.config.workflow.blockedPaths) ||
      scopes.some((entry) => matchesAny(path, entry.scope.forbidden)),
  );
  const outside = paths.filter(
    (path) => !scopes.some((entry) => matchesAny(path, entry.scope.allowed)),
  );
  if (forbidden.length || outside.length)
    return err(
      // Workers never saw the details and deleted VISP state guessing which change it meant.
      vispError(
        "SCOPE_VIOLATION",
        `Changes exceed the authorized slice scope: ${scopeList(forbidden, outside)}`,
        {
          details: {
            forbidden,
            outside,
            deleted: paths.filter((path) => current.value[path] === undefined),
          },
          recovery:
            "Restore unintended changes to the named files, or add intended ones to the slice scope with a reason and run visp work again. Never delete .visp/ or the pinned acceptance tests. Pass temporary brief input through --from - to avoid creating a product file.",
        },
      ),
    );
  const limit = workspace.policy.maxChangedFiles ?? workspace.config.workflow.maxChangedFiles;
  if (paths.length > limit)
    return err(
      vispError(
        "SCOPE_VIOLATION",
        `Changed-file count ${paths.length} exceeds configured limit ${limit}`,
      ),
    );
  return ok(undefined);
}

function scopeList(forbidden: readonly string[], outside: readonly string[]): string {
  const named = [...new Set([...forbidden, ...outside])];
  const shown = named.slice(0, 8).join(", ");
  return named.length > 8 ? `${shown} and ${named.length - 8} more` : shown;
}
