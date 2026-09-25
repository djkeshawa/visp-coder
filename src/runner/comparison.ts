import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { z } from "zod";
import { canonicalJson, hashValue, sha256 } from "../core/hash.js";
import { canonicalProjectRoot, isInside } from "../core/paths.js";
import {
  type Assignment,
  type armSchema,
  baselineSchema,
  COMPARISON_ARMS,
  COMPARISON_POLICY,
  type ComparisonObservation,
  type ComparisonSpec,
  comparisonObservationSchema,
  comparisonSpecSchema,
  digest,
  filePinSchema,
  type PreparedComparison,
  type TreePin,
} from "./comparison-contracts.js";

export {
  COMPARISON_ARMS,
  COMPARISON_POLICY,
  type ComparisonObservation,
  type ComparisonSpec,
  comparisonObservationSchema,
  comparisonSpecSchema,
  type PreparedComparison,
} from "./comparison-contracts.js";

/** Pins local inputs only. It has no dependency on experiment execution or host adapters. */
export async function prepareComparison(
  input: ComparisonSpec,
  outputDirectory: string,
): Promise<PreparedComparison> {
  const spec = comparisonSpecSchema.parse(input);
  const destination = canonicalProjectRoot(outputDirectory);
  await requireAbsent(destination);
  for (const root of [
    spec.replacement.root,
    ...spec.tasks.flatMap((task) => [task.startDirectory, task.oracleDirectory]),
  ]) {
    if (isInside(await realpath(root), destination))
      throw new Error("Comparison output must be outside pinned input trees");
  }
  await mkdir(dirname(destination), { recursive: true });
  const staging = join(dirname(destination), `.visp-comparison-${randomUUID()}`);
  await mkdir(join(staging, "objects"), { recursive: true, mode: 0o700 });
  try {
    const prepared = await pinComparison(spec, staging);
    await writeFile(
      join(staging, "comparison.json"),
      `${canonicalJson({ manifest: prepared, sha256: hashValue(prepared) })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    // Stage beside the output to keep publication on the same filesystem.
    await requireAbsent(destination);
    await rename(staging, destination);
    return prepared;
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
}

async function pinComparison(spec: ComparisonSpec, directory: string): Promise<PreparedComparison> {
  const legacyManifest = await pinFile(spec.legacy.manifest, directory);
  const manifest = baselineSchema.parse(JSON.parse(legacyManifest.bytes.toString("utf8")));
  const source = manifest.files.filter(
    (file) =>
      file.path.startsWith("src/") || ["package.json", "pnpm-lock.yaml"].includes(file.path),
  );
  const build = manifest.files.filter((file) => file.path.startsWith("dist/"));
  if (source.length === 0 || build.length === 0)
    throw new Error(
      "Legacy baseline must pin source and actual dist files, including uncommitted changes",
    );
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length)
    throw new Error("Legacy baseline contains duplicate paths");
  const archive = await pinFile(spec.legacy.archive, directory);
  const instructions = {} as Record<
    "common" | z.infer<typeof armSchema>,
    z.infer<typeof filePinSchema>[]
  >;
  for (const key of ["common", ...COMPARISON_ARMS] as const) {
    instructions[key] = [];
    for (const path of spec.instructions[key])
      instructions[key].push((await pinFile(path, directory)).pin);
  }
  const tools = [];
  for (const tool of spec.tools) {
    const pinned = await pinFile(await realpath(tool.executable), directory, 512 * 1024 * 1024);
    tools.push({ ...tool, sha256: pinned.pin.sha256 });
  }
  const tasks = [];
  for (const task of spec.tasks) {
    const startRoot = await realpath(task.startDirectory);
    const oracleRoot = await realpath(task.oracleDirectory);
    if (isInside(startRoot, oracleRoot) || isInside(oracleRoot, startRoot))
      throw new Error("Held-out oracle must be separate from the candidate starting tree");
    const promptFile = await realpath(task.promptFile);
    if (isInside(oracleRoot, promptFile))
      throw new Error("Implementation prompt must be separate from the held-out oracle");
    const prompt = await pinFile(promptFile, directory);
    tasks.push({
      id: task.id,
      cohort: task.cohort,
      prompt: prompt.bytes.toString("utf8"),
      promptSha256: prompt.pin.sha256,
      start: await pinTree(startRoot, ["."], directory),
      oracle: await pinTree(oracleRoot, ["."], directory),
    });
  }
  return {
    schemaVersion: 1,
    kind: "prepared-product-comparison",
    study: spec.study,
    seed: spec.seed,
    status: "prepared-awaiting-budget",
    runnable: false,
    budget: null,
    repetitions: 3,
    policy: COMPARISON_POLICY,
    model: spec.model,
    tools,
    allowedTools: spec.allowedTools,
    customSkills: "disabled",
    environment: {
      ...spec.environment,
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      nodeVersion: process.version,
    },
    instructions,
    legacy: {
      manifest,
      manifestSha256: legacyManifest.pin.sha256,
      archiveSha256: archive.pin.sha256,
      sourceSha256: hashValue(source),
      buildSha256: hashValue(build),
      archiveMapping: "manifest-recorded",
    },
    replacement: {
      source: await pinTree(spec.replacement.root, spec.replacement.sourcePaths, directory),
      build: await pinTree(spec.replacement.root, [spec.replacement.buildPath], directory),
    },
    tasks,
    assignments: assignComparisons(
      spec.study,
      spec.seed,
      tasks.map((task) => task.id),
    ),
  };
}

export function assignComparisons(
  study: string,
  seed: string,
  taskIds: readonly string[],
): Assignment[] {
  if (!study || !seed || taskIds.length !== 3 || new Set(taskIds).size !== 3)
    throw new Error("Comparison requires a study, seed, and three distinct tasks");
  return [...taskIds]
    .sort()
    .flatMap((task) =>
      COMPARISON_ARMS.flatMap((arm) =>
        Array.from({ length: 3 }, (_, repetition) => ({
          id: `${study}.${task}.${arm}.${repetition + 1}`,
          task,
          arm,
          repetition: repetition + 1,
          order: 0,
        })),
      ),
    )
    .sort((a, b) => sha256(`${seed}:${a.id}`).localeCompare(sha256(`${seed}:${b.id}`)))
    .map((assignment, order) => ({ ...assignment, order }));
}

async function pinTree(
  rootInput: string,
  selected: readonly string[],
  directory: string,
): Promise<TreePin> {
  const root = await realpath(rootInput);
  const files = new Map<string, z.infer<typeof filePinSchema>>();
  let total = 0;
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Pinned tree refuses symlinks: ${path}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
      return;
    }
    const pinned = await pinFile(path, directory);
    total += pinned.pin.bytes;
    if (total > 256 * 1024 * 1024 || files.size >= 25_000)
      throw new Error("Pinned tree exceeds 256 MiB or 25,000 files");
    const key = relative(root, path).replace(/\\/g, "/");
    files.set(key, { ...pinned.pin, path: key });
  };
  for (const path of selected) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
      throw new Error("Pinned paths must stay within their root");
    const target = resolve(root, path);
    if (!isInside(root, target) || (await realpath(target)) !== target)
      throw new Error("Pinned tree refuses symlink parents or escaping paths");
    await visit(target);
  }
  if (files.size === 0) throw new Error("Pinned input tree is empty");
  const entries = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: hashValue(entries), files: entries };
}

async function pinFile(path: string, directory: string, maximumBytes = 256 * 1024 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes)
    throw new Error(
      `Pin requires a regular file of at most ${maximumBytes / 1024 / 1024} MiB: ${path}`,
    );
  const bytes = await readFile(path);
  const pin = {
    path,
    sha256: sha256(bytes),
    bytes: bytes.length,
    executable: Boolean(info.mode & 0o111),
  };
  const object = join(directory, "objects", pin.sha256);
  try {
    await writeFile(object, bytes, { flag: "wx", mode: 0o600 });
  } catch (cause) {
    if (
      (cause as NodeJS.ErrnoException).code !== "EEXIST" ||
      sha256(await readFile(object)) !== pin.sha256
    )
      throw cause;
  }
  return { pin, bytes };
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  throw new Error(`Comparison output already exists: ${path}`);
}

/** Descriptive results keep missing assessments, failures, and quality dimensions visible. */
export function summarizeComparison(
  prepared: PreparedComparison,
  input: readonly ComparisonObservation[],
) {
  const rows = comparisonObservationSchema.array().parse(input);
  const assignments = new Map(
    prepared.assignments.map((assignment) => [assignment.id, assignment]),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    if (!assignments.has(row.assignmentId) || seen.has(row.assignmentId))
      throw new Error("Observation assignment is unknown or duplicated");
    seen.add(row.assignmentId);
  }
  const arms = COMPARISON_ARMS.map((arm) => {
    const expected = prepared.assignments.filter((assignment) => assignment.arm === arm).length;
    const observed = rows.filter((row) => assignments.get(row.assignmentId)?.arm === arm);
    return {
      arm,
      expected,
      observed: observed.length,
      missingRuns: expected - observed.length,
      completed: observed.filter((row) => row.status === "completed").length,
      failures: observed.filter((row) => row.status !== "completed").length,
      blindedAssessments: observed.filter((row) => row.assessment?.blinded).length,
      capabilities: ["graph", "memory", "browser", "review"].map((capability) => {
        const signals = observed.flatMap(
          (row) =>
            row.capabilitySignals?.filter((signal) => signal.capability === capability) ?? [],
        );
        return {
          capability,
          unmeasuredRuns: expected - signals.length,
          relevantRuns: signals.filter((signal) => signal.relevantInput).length,
          invokedRuns: signals.filter((signal) => signal.invoked).length,
          reportedDecisionChanges: signals.filter((signal) => signal.decisionChange).length,
          provenance: "externally-reported-not-attested",
        };
      }),
      loop: Object.fromEntries(
        (["firstPassCorrectness", "repairedCorrectness", "completedCorrections"] as const).map(
          (key) => [
            key,
            measurements(
              observed.map((row) => row.loop?.[key] ?? null),
              expected,
            ),
          ],
        ),
      ),
      quality: Object.fromEntries(
        COMPARISON_POLICY.primary.map((key) => [
          key,
          measurements(
            observed.map((row) => row.quality[key]),
            expected,
          ),
        ]),
      ),
      secondary: Object.fromEntries(
        COMPARISON_POLICY.secondary.map((key) => [
          key,
          measurements(
            observed.map((row) => row.secondary[key]),
            expected,
          ),
        ]),
      ),
    };
  });
  return {
    study: prepared.study,
    policy: COMPARISON_POLICY,
    arms,
    promotion: {
      eligible: false,
      reason:
        "Three-task pilot is descriptive; no automatic quality, confidence, or cost-efficiency claim",
    },
  };
}

function measurements(values: readonly (number | null)[], expected: number) {
  const observed = values.filter((value): value is number => value !== null);
  const sum = observed.reduce((total, value) => total + value, 0);
  return {
    observed: observed.length,
    missing: expected - observed.length,
    mean: observed.length > 0 ? sum / observed.length : null,
    observedSum: observed.length > 0 ? sum : null,
  };
}

export async function readPreparedComparison(directory: string): Promise<PreparedComparison> {
  const envelope = JSON.parse(
    (await readFile(join(directory, "comparison.json"))).toString("utf8"),
  ) as { manifest: PreparedComparison; sha256: string };
  if (
    envelope.manifest?.schemaVersion !== 1 ||
    envelope.manifest.kind !== "prepared-product-comparison" ||
    envelope.manifest.status !== "prepared-awaiting-budget" ||
    envelope.manifest.customSkills !== "disabled" ||
    envelope.manifest.budget !== null ||
    envelope.manifest.runnable !== false ||
    hashValue(envelope.manifest) !== envelope.sha256
  )
    throw new Error("Prepared comparison identity is invalid");
  const manifest = envelope.manifest;
  const expected = assignComparisons(
    manifest.study,
    manifest.seed,
    manifest.tasks.map((task) => task.id),
  );
  if (hashValue(expected) !== hashValue(manifest.assignments))
    throw new Error("Prepared assignments changed");
  await verifyObjects(
    directory,
    preparedObjectHashes(manifest),
    new Set(manifest.tools.map((tool) => tool.sha256)),
  );
  return manifest;
}

function preparedObjectHashes(manifest: PreparedComparison): Set<string> {
  const hashes = new Set([
    manifest.legacy.manifestSha256,
    manifest.legacy.archiveSha256,
    ...manifest.tools.map((tool) => tool.sha256),
  ]);
  for (const entries of Object.values(manifest.instructions))
    for (const file of entries) hashes.add(filePinSchema.parse(file).sha256);
  for (const task of manifest.tasks) {
    if (sha256(task.prompt) !== task.promptSha256)
      throw new Error("Prepared prompt identity changed");
    hashes.add(task.promptSha256);
  }
  const trees = [
    manifest.replacement.source,
    manifest.replacement.build,
    ...manifest.tasks.flatMap((task) => [task.start, task.oracle]),
  ];
  for (const tree of trees) {
    if (hashValue(tree.files) !== tree.sha256) throw new Error("Prepared tree identity changed");
    for (const file of tree.files) hashes.add(filePinSchema.parse(file).sha256);
  }
  return hashes;
}

async function verifyObjects(
  directory: string,
  hashes: ReadonlySet<string>,
  toolHashes: ReadonlySet<string>,
): Promise<void> {
  const objects = canonicalProjectRoot(join(directory, "objects"));
  for (const hash of hashes) {
    const path = join(objects, digest.parse(hash));
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > (toolHashes.has(hash) ? 512 : 256) * 1024 * 1024 ||
      sha256(await readFile(path)) !== hash
    )
      throw new Error("Prepared object integrity failed");
  }
}
