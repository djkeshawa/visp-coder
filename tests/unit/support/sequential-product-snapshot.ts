import { HARD_IGNORED_DIRS } from "../../../src/core/constants.js";
import { vispError } from "../../../src/core/errors.js";
import type { ProjectFileSystem } from "../../../src/core/fs.js";
import { repositoryFiles, repositoryGitlinks } from "../../../src/core/git.js";
import { repositorySourceObjects } from "../../../src/core/git-source.js";
import { matchesAny, matchesPattern } from "../../../src/core/patterns.js";
import { err, ok, type Result } from "../../../src/core/result.js";
import { byproductProtection, skippedByproduct } from "../../../src/workflow/product/byproducts.js";
import type { ProductBrief } from "../../../src/workflow/product/model.js";
import { sourceEntryHash } from "../../../src/workflow/product/source-entry.js";
import { repositorySourceIdentity } from "../../../src/workflow/product/source-git.js";
import { sourceInputPatterns } from "../../../src/workflow/product/source-inputs.js";
import { readProductRecord } from "../../../src/workflow/product/store.js";
import type { WorkspaceState } from "../../../src/workflow/state.js";

// Frozen sequential snapshot/reader from the pre-optimization implementation.
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
      `Product evidence input budget exceeded at ${path}; declared slice scopes and check inputs exceed the snapshot budget`,
      {
        details: INPUT_LIMITS,
        recovery:
          "Narrow slice scopes and check file patterns, or reduce oversized declared inputs. A pattern that starts with a wildcard skips tool directories (node_modules, dist, build, .venv and similar) unless it names them. Other tracked files use Git identities and do not consume this budget.",
      },
    ),
  );
}

/** Generated state is excluded unless it is explicitly declared as executable check input. */
export async function sequentialProductSourceSnapshot(
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
  const objects = await repositorySourceObjects(workspace.paths.root);
  if (!objects.ok) return objects;
  const patterns = sourceInputPatterns(workspace, selected.value);
  const algorithm =
    [...objects.value.entries.values()][0]?.object.length === 64 ? "sha256" : "sha1";
  const protection = byproductProtection(workspace, selected.value);
  const paths = listed.value.filter(
    (path) =>
      path !== ".visp" &&
      !path.startsWith(".visp/") &&
      !skippedByproduct(path, objects.value.entries.has(path), protection),
  );
  return sequentialSnapshotSourceFiles(
    workspace,
    [...new Set([...paths, ...declared.value])].sort(),
    patterns,
    objects.value,
    algorithm,
  );
}

export async function sequentialSnapshotSourceFiles(
  workspace: WorkspaceState,
  paths: string[],
  patterns: string[],
  objects: {
    entries: Map<string, import("../../../src/core/git-source.js").GitSourceEntry>;
    dirty: Set<string>;
  },
  algorithm: "sha1" | "sha256",
): Promise<Result<Record<string, string>>> {
  const files: Record<string, string> = {};
  const budget: InputBudget = { entries: 0, bytes: 0 };
  for (const path of paths) {
    const hash = matchesAny(path, patterns)
      ? await productFileHash(workspace, path, budget)
      : await repositorySourceIdentity(workspace, path, objects, algorithm);
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
  budget.entries += 1;
  if (budget.entries > INPUT_LIMITS.entries) return inputLimit(path);
  const entry = await readSourceEntry(
    workspace.files,
    path,
    Math.min(INPUT_LIMITS.fileBytes, INPUT_LIMITS.totalBytes - budget.bytes),
  );
  if (!entry.ok) return entry;
  budget.bytes += entry.value.bytes?.byteLength ?? 0;
  return ok(sourceEntryHash(entry.value.bytes, entry.value.mode, entry.value.symlink));
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
    const selected = await declaredPatternFiles(workspace, pattern, budget);
    if (!selected.ok) return selected;
    for (const path of selected.value) paths.add(path);
  }
  return ok([...paths]);
}

async function declaredPatternFiles(
  workspace: WorkspaceState,
  pattern: string,
  budget: InputBudget,
): Promise<Result<string[]>> {
  const wildcard = pattern.search(/[*?[]/);
  const prefix =
    wildcard < 0
      ? pattern
      : pattern.slice(0, pattern.lastIndexOf("/", wildcard) + 1).replace(/\/$/, "");
  const link = await workspace.files.readSymbolicLink(prefix || ".");
  if (!link.ok) return link;
  if (link.value !== undefined) return ok(wildcard < 0 ? [pattern] : []);
  const metadata = await workspace.files.readMetadata(prefix || ".");
  if (!metadata.ok) return metadata;
  if (wildcard < 0 && metadata.value?.type !== "directory") return ok([pattern]);
  return matchingCheckFiles(workspace, prefix || ".", pattern, budget, 0);
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
  const named = literalSegments(pattern);
  // A wildcard never walks tool directories (`**/x` would list node_modules); a pattern that
  // names one, or starts inside it, still reaches it.
  const walked = entries.value.filter(
    (entry) =>
      entry.name !== ".git" &&
      !(entry.type === "directory" && HARD_IGNORED.has(entry.name) && !named.has(entry.name)),
  );
  for (const entry of walked) {
    const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
    if (entry.type === "directory") {
      const nested = await matchingCheckFiles(workspace, path, pattern, budget, depth + 1);
      if (!nested.ok) return nested;
      files.push(...nested.value);
    } else if (matchesPattern(path, pattern)) files.push(path);
  }
  return ok(files);
}

const HARD_IGNORED = new Set<string>(HARD_IGNORED_DIRS);

function literalSegments(pattern: string): Set<string> {
  return new Set(pattern.split("/").filter((segment) => segment && !/[*?[]/.test(segment)));
}

async function readSourceEntry(files: ProjectFileSystem, path: string, maxBytes: number) {
  const link = await files.readSymbolicLink(path);
  if (!link.ok) return link;
  if (link.value !== undefined) return ok({ bytes: link.value, mode: 0o777, symlink: true });
  const metadata = await files.readMetadata(path);
  if (!metadata.ok) return metadata;
  if (metadata.value && metadata.value.type !== "file")
    return err(
      vispError(
        "UNSUPPORTED",
        `Product evidence requires files or symlinks; cannot inspect ${path}`,
      ),
    );
  if ((metadata.value?.size ?? 0) > maxBytes)
    return err(vispError("UNSUPPORTED", `Product evidence input budget exceeded at ${path}`));
  const read = await files.readBytesIfExists(path);
  if (!read.ok) return read;
  if ((read.value?.length ?? 0) > maxBytes)
    return err(vispError("UNSUPPORTED", `Product evidence input budget exceeded at ${path}`));
  return ok({ bytes: read.value, mode: metadata.value?.mode, symlink: false });
}
