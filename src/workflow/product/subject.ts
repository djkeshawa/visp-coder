import { browserExecutableIdentity } from "../../core/browser-executable.js";
import { vispError } from "../../core/errors.js";
import { productIdentityEnvironment } from "../../core/execution-environment.js";
import { repositoryFiles, repositoryGitlinks } from "../../core/git.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { matchesPattern } from "../../core/patterns.js";
import { err, ok, type Result } from "../../core/result.js";
import { runtimeIdentity } from "../../core/version.js";
import type { WorkspaceState } from "../state.js";
import { type ProductBrief, type ProductSlice, sliceDigest } from "./model.js";
import { readProductRecord } from "./store.js";

const INPUT_LIMITS = {
  entries: 20_000,
  depth: 64,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
};
interface InputBudget {
  entries: number;
  bytes: number;
}
function inputLimit(path: string) {
  return err(
    vispError(
      "UNSUPPORTED",
      `Product evidence input budget exceeded at ${path}; narrow declared input patterns or reduce oversized inputs`,
      { details: INPUT_LIMITS },
    ),
  );
}

/** Generated state is excluded unless it is explicitly declared as executable check input. */
export async function productSourceSnapshot(
  workspace: WorkspaceState,
  brief?: ProductBrief,
): Promise<Result<Record<string, string>>> {
  const links = await repositoryGitlinks(workspace.paths.root);
  if (!links.ok) return links;
  if (links.value.length)
    return err(
      vispError(
        "UNSUPPORTED",
        "Product workflow does not support repositories containing Git submodules",
        { details: { paths: links.value } },
      ),
    );
  const listed = await repositoryFiles(workspace.paths.root);
  if (!listed.ok) return listed;
  const selected = await subjectBrief(workspace, brief);
  if (!selected.ok) return selected;
  const declared = await declaredCheckFiles(workspace, selected.value);
  if (!declared.ok) return declared;
  const paths = listed.value.filter((path) => path !== ".visp" && !path.startsWith(".visp/"));
  const files: Record<string, string> = {};
  const budget: InputBudget = { entries: 0, bytes: 0 };
  for (const path of [...new Set([...paths, ...declared.value])].sort()) {
    const hash = await productFileHash(workspace, path, budget);
    if (!hash.ok) return hash;
    files[path] = hash.value;
  }
  return ok(files);
}

async function productFileHash(
  workspace: WorkspaceState,
  path: string,
  budget: InputBudget,
): Promise<Result<string>> {
  const metadata = await workspace.files.readMetadata(path);
  if (!metadata.ok) return metadata;
  if (metadata.value && metadata.value.type !== "file")
    return err(
      vispError("UNSUPPORTED", `Product evidence requires regular files; cannot inspect ${path}`, {
        details: { path, type: metadata.value.type },
      }),
    );
  budget.entries += 1;
  budget.bytes += metadata.value?.size ?? 0;
  if (
    budget.entries > INPUT_LIMITS.entries ||
    (metadata.value?.size ?? 0) > INPUT_LIMITS.fileBytes ||
    budget.bytes > INPUT_LIMITS.totalBytes
  )
    return inputLimit(path);
  const content = await workspace.files.readBytesIfExists(path);
  if (!content.ok) return content;
  // A file can grow between metadata and the confined read.
  budget.bytes += (content.value?.byteLength ?? 0) - (metadata.value?.size ?? 0);
  if (
    (content.value?.byteLength ?? 0) > INPUT_LIMITS.fileBytes ||
    budget.bytes > INPUT_LIMITS.totalBytes
  )
    return inputLimit(path);
  return ok(
    hashValue({
      hash: content.value === undefined ? null : sha256(content.value),
      mode: metadata.value?.mode,
    }),
  );
}

export async function productSourceDigest(
  workspace: WorkspaceState,
  brief?: ProductBrief,
  snapshot?: Record<string, string>,
): Promise<Result<string>> {
  const files = snapshot ? ok(snapshot) : await productSourceSnapshot(workspace, brief);
  if (!files.ok) return files;
  const controls: Record<string, string | null> = {};
  for (const path of [workspace.paths.config, workspace.paths.policy, workspace.paths.overrides]) {
    const bytes = await workspace.files.readBytesIfExists(path);
    if (!bytes.ok) return bytes;
    controls[path] = bytes.value === undefined ? null : sha256(bytes.value);
  }
  return ok(
    hashValue({
      version: 3,
      files: files.value,
      controls,
      validationCommands: workspace.config.workflow.validationCommands,
      runtime: {
        ...runtimeIdentity(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      environment: productIdentityEnvironment(),
      browser: await browserExecutableIdentity(),
    }),
  );
}

async function subjectBrief(
  workspace: WorkspaceState,
  brief?: ProductBrief,
): Promise<Result<ProductBrief | undefined>> {
  if (brief || !workspace.status?.activeFeature) return ok(brief);
  const record = await readProductRecord(workspace, { feature: workspace.status.activeFeature });
  if (!record.ok) return record.error.code === "MIGRATION_REQUIRED" ? ok(undefined) : record;
  return ok(record.value.brief);
}

async function declaredCheckFiles(
  workspace: WorkspaceState,
  brief?: ProductBrief,
): Promise<Result<string[]>> {
  if (!brief) return ok([]);
  const patterns = [
    ...new Set([
      ...brief.checks.flatMap((check) => [...check.files, ...(check.verifierFiles ?? [])]),
      ...brief.acceptanceBaseline.flatMap((check) => check.files.map((file) => file.path)),
    ]),
  ];
  const paths = new Set<string>();
  const budget: InputBudget = { entries: 0, bytes: 0 };
  for (const pattern of patterns) {
    const wildcard = pattern.search(/[*?[]/);
    const prefix =
      wildcard < 0
        ? pattern
        : pattern.slice(0, pattern.lastIndexOf("/", wildcard) + 1).replace(/\/$/, "");
    const metadata = await workspace.files.readMetadata(prefix || ".");
    if (!metadata.ok) return metadata;
    if (wildcard < 0 && metadata.value?.type !== "directory") {
      paths.add(pattern);
      continue;
    }
    const selected = await matchingCheckFiles(workspace, prefix || ".", pattern, budget, 0);
    if (!selected.ok) return selected;
    for (const path of selected.value) paths.add(path);
  }
  return ok([...paths]);
}

async function matchingCheckFiles(
  workspace: WorkspaceState,
  directory: string,
  pattern: string,
  budget: InputBudget,
  depth: number,
): Promise<Result<string[]>> {
  if (depth > INPUT_LIMITS.depth) return inputLimit(directory);
  const entries = await workspace.files.listEntries(directory);
  if (!entries.ok) return entries;
  budget.entries += entries.value.length;
  if (budget.entries > INPUT_LIMITS.entries) return inputLimit(directory);
  const files: string[] = [];
  for (const entry of entries.value.filter((entry) => entry.name !== ".git")) {
    const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
    if (entry.type === "directory") {
      const nested = await matchingCheckFiles(workspace, path, pattern, budget, depth + 1);
      if (!nested.ok) return nested;
      files.push(...nested.value);
    } else if (matchesPattern(path, pattern)) files.push(path);
  }
  return ok(files);
}

export function productContractDigest(brief: ProductBrief, slice?: ProductSlice): string {
  return slice
    ? sliceDigest(brief, slice)
    : hashValue({
        version: 3,
        ...featureContractInputs(brief),
        decisions: brief.decisions,
        slices: brief.slices.map((entry) => ({
          id: entry.id,
          contractDigest: sliceDigest(brief, entry),
        })),
      });
}

/** Only historical acceptance reads may recognize this identity; it never credits fresh evidence. */
export function legacyFeatureContractDigest(brief: ProductBrief): string {
  return hashValue(featureContractInputs(brief));
}

function featureContractInputs(brief: ProductBrief) {
  return {
    originalRequest: brief.originalRequest,
    outcomes: brief.outcomes,
    examples: brief.examples,
    checks: brief.checks,
    acceptanceBaseline: brief.acceptanceBaseline,
    design: brief.design,
  };
}

/** Review-cycle identity excludes VISP controls and runtime changes; it is not execution freshness. */
export function productImplementationDigest(
  workspace: WorkspaceState,
  snapshot: Record<string, string>,
): string {
  const controls = new Set(
    [workspace.paths.config, workspace.paths.policy, workspace.paths.overrides].map((path) =>
      workspace.paths.relative(path),
    ),
  );
  return hashValue(
    Object.fromEntries(Object.entries(snapshot).filter(([path]) => !controls.has(path))),
  );
}
