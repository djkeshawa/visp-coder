import { parse, stringify } from "yaml";
import { PRODUCT_STATE_VERSION } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
} from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { resolveFeature } from "../state.js";
import {
  type ProductBrief,
  type ProductState,
  parseProductBrief,
  productStateSchema,
} from "./model.js";

export interface ProductSelection {
  readonly feature?: string;
  readonly task?: string;
  /** Mutating work/check operations only; does not change host permissions. */
  readonly retryEnvironment?: boolean;
}
export interface ProductRecord {
  readonly brief: ProductBrief;
  readonly state: ProductState;
  readonly briefText: string;
  readonly stateText: string;
}
export const briefPath = (state: WorkspaceState, feature: string): string =>
  state.paths.featureFile(feature, "brief.yaml");
export const productStatePath = (state: WorkspaceState, feature: string): string =>
  state.paths.featureFile(feature, "product-state.json");
export const authorizationPath = (state: WorkspaceState, feature: string): string =>
  state.paths.stateFile(`state/product-authorizations/${feature}.json`);
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export async function readProductRecord(
  workspace: WorkspaceState,
  options: ProductSelection = {},
  allowDraft = false,
): Promise<Result<ProductRecord>> {
  return readRecord(workspace, options, allowDraft, false);
}

/** Only explicit migration may interpret the previous state generation. */
export function readProductRecordForMigration(
  workspace: WorkspaceState,
  options: ProductSelection,
) {
  return readRecord(workspace, options, false, true);
}

async function readRecord(
  workspace: WorkspaceState,
  options: ProductSelection,
  allowDraft: boolean,
  migrateVersionTwo: boolean,
): Promise<Result<ProductRecord>> {
  const resolved = resolveFeature(workspace, options.feature);
  if (!resolved.ok) return resolved;
  const feature = resolved.value;
  const content = await workspace.files.readTextIfExists(briefPath(workspace, feature));
  if (!content.ok) return content;
  if (content.value === undefined) return missingBrief(workspace, feature);
  const brief = parseBriefText(content.value, feature);
  if (!brief.ok) return brief;
  const stored = await workspace.files.readText(productStatePath(workspace, feature));
  if (!stored.ok) return stored;
  const state = parseStateText(stored.value, feature, migrateVersionTwo);
  if (!state.ok) return state;
  if (!allowDraft && brief.value.originalRequest !== state.value.intentSnapshot.originalRequest)
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "The brief original request differs from its preserved product contract",
      ),
    );
  // Direct edits are drafts until the shared brief validator records the revision.
  if (!allowDraft && state.value.briefDigest !== hashValue(brief.value))
    return err(
      vispError("ARTIFACT_INVALID", "Brief changed outside the validated update operation", {
        recovery: `visp brief --feature ${feature} --from <draft.yaml> --reason <reason>`,
        details: { externalBriefEdit: true },
      }),
    );
  return ok({
    brief: brief.value,
    state: state.value,
    briefText: content.value,
    stateText: stored.value,
  });
}

async function missingBrief(workspace: WorkspaceState, feature: string): Promise<Result<never>> {
  const legacy = await workspace.files.exists(workspace.paths.featureFile(feature, "intent.json"));
  if (!legacy.ok) return legacy;
  return err(
    vispError(
      legacy.value ? "MIGRATION_REQUIRED" : "ARTIFACT_MISSING",
      legacy.value
        ? `Feature ${feature} uses the replaced workflow`
        : `Feature ${feature} does not exist`,
      {
        recovery: legacy.value
          ? `visp migrate --feature ${feature} --dry-run`
          : "visp feature <goal>",
      },
    ),
  );
}

function parseBriefText(content: string, feature: string): Result<ProductBrief> {
  let input: unknown;
  try {
    input = parse(content);
  } catch (cause) {
    return err(vispError("ARTIFACT_INVALID", `Invalid brief YAML: ${String(cause)}`));
  }
  const brief = parseProductBrief(input);
  if (!brief.ok) return brief;
  return brief.value.feature === feature
    ? brief
    : err(vispError("ARTIFACT_INVALID", "Brief feature does not match its directory"));
}

function parseStateText(
  content: string,
  feature: string,
  migrateVersionTwo: boolean,
): Result<ProductState> {
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    return err(vispError("ARTIFACT_INVALID", "Invalid product state JSON"));
  }
  const candidate =
    typeof input === "object" && input !== null && "version" in input && input.version === 2
      ? { ...input, version: PRODUCT_STATE_VERSION }
      : input;
  const historical = candidate !== input;
  const state = productStateSchema.safeParse(candidate);
  if (!state.success || state.data.feature !== feature)
    return err(vispError("ARTIFACT_INVALID", "Invalid product state"));
  if (historical && !migrateVersionTwo)
    return err(
      vispError(
        "MIGRATION_REQUIRED",
        "Product state version 2 requires an explicit upgrade before use",
        {
          recovery:
            "Stop old VISP processes; run visp-migrate --project <project> preview, then apply; restart MCP with the upgraded executable",
        },
      ),
    );
  return ok(state.data);
}

export async function readProductBrief(
  state: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductBrief>> {
  const record = await readProductRecord(state, options);
  return record.ok ? ok(record.value.brief) : record;
}

export function recordMutations(
  workspace: WorkspaceState,
  record: ProductRecord | undefined,
  brief: ProductBrief,
  state: ProductState,
): FileMutation[] {
  return [
    {
      kind: "write",
      path: briefPath(workspace, brief.feature),
      content: stringify(brief),
      expectedBefore: filePrecondition(record?.briefText),
    },
    {
      kind: "write",
      path: productStatePath(workspace, brief.feature),
      content: json(state),
      expectedBefore: filePrecondition(record?.stateText),
    },
  ];
}

export async function saveProductState(
  workspace: WorkspaceState,
  record: ProductRecord,
  next: ProductState,
  extra: FileMutation[] = [],
): Promise<Result<void>> {
  const result = await applyFileTransaction(workspace.paths.root, "product-state", [
    // This precondition guards the contract too, even when this operation only changes derived state.
    {
      kind: "write",
      path: briefPath(workspace, record.brief.feature),
      content: record.briefText,
      expectedBefore: filePrecondition(record.briefText),
    },
    {
      kind: "write",
      path: productStatePath(workspace, record.brief.feature),
      content: json(next),
      expectedBefore: filePrecondition(record.stateText),
    },
    ...extra,
  ]);
  return result.ok ? ok(undefined) : result;
}

export async function statusMutation(
  workspace: WorkspaceState,
  feature: string,
  task: string | undefined,
  command: string,
): Promise<Result<FileMutation>> {
  const previous = await workspace.files.readTextIfExists(workspace.paths.status);
  if (!previous.ok) return previous;
  const timestamp = new Date().toISOString();
  let base: Record<string, unknown> = { kind: "status", createdAt: timestamp };
  if (previous.value) {
    try {
      base = JSON.parse(previous.value);
    } catch {
      return err(vispError("ARTIFACT_INVALID", "Invalid status JSON"));
    }
  }
  return ok({
    kind: "write",
    path: workspace.paths.status,
    expectedBefore: filePrecondition(previous.value),
    content: json({
      ...base,
      activeFeature: feature,
      activeTask: task,
      stage: undefined,
      lastCommand: command,
      updatedAt: timestamp,
    }),
  });
}
