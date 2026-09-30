import { browserExecutableIdentity } from "../../core/browser-executable.js";
import { resolveCommandExecutable } from "../../core/command-executable.js";
import { HARD_IGNORED_DIRS } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { resolveCommand } from "../../core/exec.js";
import {
  comparisonEnvironmentParts,
  declaredEnvironment,
  productExecutionEnvironment,
} from "../../core/execution-environment.js";
import { repositoryFiles, repositoryGitlinks } from "../../core/git.js";
import { repositorySourceObjects } from "../../core/git-source.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { matchesAny, matchesPattern } from "../../core/patterns.js";
import { pythonCacheDirectory } from "../../core/python-cache.js";
import { err, ok, type Result } from "../../core/result.js";
import { runtimeIdentity } from "../../core/version.js";
import type { WorkspaceState } from "../state.js";
import { acceptanceEnvironment } from "./acceptance-environment.js";
import { byproductProtection, skippedByproduct } from "./byproducts.js";
import { isBrowserCheckCommand } from "./check-command.js";
import { type ProductBrief, type ProductCheck, type ProductSlice, sliceDigest } from "./model.js";
import { readSourceEntry, sourceEntryHash } from "./source-entry.js";
import { repositorySourceIdentity } from "./source-git.js";
import { sourceInputPatterns } from "./source-inputs.js";
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
  const files: Record<string, string> = {};
  const budget: InputBudget = { entries: 0, bytes: 0 };
  for (const path of [...new Set([...paths, ...declared.value])].sort()) {
    const hash = matchesAny(path, patterns)
      ? await productFileHash(workspace, path, budget)
      : await repositorySourceIdentity(workspace, path, objects.value, algorithm);
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

/**
 * The subject is what the product is: source, controls, validation commands, the VISP build
 * and the variables a check declares. The toolchain a check ran under is the comparison
 * identity below; it gates reuse and repair credit but never makes evidence stale to a
 * reader whose PATH, node or terminal differs.
 */
export async function productSourceDigest(
  workspace: WorkspaceState,
  brief?: ProductBrief,
  snapshot?: Record<string, string>,
): Promise<Result<string>> {
  const selected = await subjectBrief(workspace, brief);
  if (!selected.ok) return selected;
  const files = snapshot ? ok(snapshot) : await productSourceSnapshot(workspace, brief);
  if (!files.ok) return files;
  const controls: Record<string, string | null> = {};
  for (const path of [workspace.paths.config, workspace.paths.policy, workspace.paths.overrides]) {
    const bytes = await workspace.files.readBytesIfExists(path);
    if (!bytes.ok) return bytes;
    controls[path] = bytes.value === undefined ? null : sha256(bytes.value);
  }
  const { version, buildId } = runtimeIdentity();
  return ok(
    hashValue({
      version: 4,
      files: files.value,
      controls,
      validationCommands: workspace.config.workflow.validationCommands,
      runtime: { version, buildId },
      declaredEnvironment: declaredEnvironment(
        selected.value?.checks.flatMap((check) => check.environmentVariables ?? []),
      ),
    }),
  );
}

/**
 * Identity of the toolchain a check runs under: the executable its argv0 selects, the
 * browser, injection and locale variables, and declared application variables, hashed as the
 * check sees them (a pinned check sees the filtered environment). PATH text, terminal and
 * host session variables are excluded; HOME is included for an ordinary check. Reuse of a passed run and repair credit require
 * equal identities; browser-journey checks and capture runs pass no check and share the
 * union of declared variables so a check run and its capture run agree.
 */
export async function productComparisonEnvironmentDigest(
  workspace: WorkspaceState,
  brief?: ProductBrief,
  options: { check?: ProductCheck; binary?: string } = {},
): Promise<Result<string>> {
  const selected = await subjectBrief(workspace, brief);
  if (!selected.ok) return selected;
  const inherited = productExecutionEnvironment();
  const { check } = options;
  const environment = check?.id.startsWith("PINNED_")
    ? acceptanceEnvironment(inherited)
    : inherited;
  const argv0 =
    check && !isBrowserCheckCommand(check.command) ? resolveCommand(check.command) : undefined;
  const root = workspace.paths.root;
  const tool = argv0?.ok ? await toolIdentity(argv0.value[0] ?? "", root, environment) : undefined;
  const pinned = check?.id.startsWith("PINNED_") === true;
  const declared =
    check?.environmentVariables ??
    selected.value?.checks.flatMap((entry) => entry.environmentVariables ?? []);
  const { version, buildId } = runtimeIdentity();
  return ok(
    hashValue({
      version: 1,
      runtime: { version, buildId },
      platform: `${process.platform}-${process.arch}`,
      tool,
      // Any command can start a grandchild: `sh -c` or `npm test` hides a shimmed node or python.
      toolchain: await toolchainIdentity(root, environment),
      browser: await browserExecutableIdentity(options.binary ?? environment.CHROME_BIN),
      ...comparisonEnvironmentParts(environment, await ownBytecodeCache(environment)),
      // A pinned run gets a private HOME per run; an ordinary check reads the operator's.
      home: pinned ? undefined : environment.HOME,
      declared: declaredEnvironment(declared, environment),
    }),
  );
}

/** The realpath and size of what a name resolves to; on Windows, where nothing resolves, the PATH text. */
async function toolIdentity(name: string, root: string, environment: Record<string, string>) {
  const found = await resolveCommandExecutable(name, root, environment);
  if (found) return found;
  return process.platform === "win32" ? { name, pathText: environment.PATH ?? null } : null;
}

async function toolchainIdentity(root: string, environment: Record<string, string>) {
  return Object.fromEntries(
    await Promise.all(
      ["node", "python3", "python"].map(
        async (name) => [name, await toolIdentity(name, root, environment)] as const,
      ),
    ),
  );
}

/** The bytecode cache VISP sets for checks, when the environment holds exactly that. */
async function ownBytecodeCache(environment: Record<string, string>) {
  if (environment.PYTHONPYCACHEPREFIX === undefined) return undefined;
  return pythonCacheDirectory().catch(() => undefined);
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
