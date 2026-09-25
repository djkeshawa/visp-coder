import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { hashValue, sha256 } from "../core/hash.js";
import { assertOutside, immutableJson, type SourceSnapshot, safeChild } from "./artifacts.js";
import { execute, executeStream } from "./process.js";
import { parseTestReport } from "./reports.js";
import { inspectRun } from "./run.js";

const absolute = z.string().refine(isAbsolute, "Absolute path required");
export const evaluatorSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/),
    image: z.string().regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/),
    engine: z
      .object({
        executable: absolute,
        executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
        version: z.string().min(1),
      })
      .strict(),
    policyDirectory: absolute,
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    command: z
      .array(z.string())
      .min(1)
      .refine(
        (argv) => Boolean(argv[0]?.startsWith("/evaluator/")) && !argv[0]?.includes(".."),
        "Entrypoint must be in the pinned evaluator",
      ),
    format: z.enum(["vitest", "pytest", "playwright"]),
    reportFile: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          safeChild("/results", value);
          return true;
        } catch {
          return false;
        }
      }, "Confined report path required"),
    requiredTests: z.array(z.string().min(1)).min(1),
    timeoutMs: z.number().int().positive().max(3_600_000),
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
  })
  .strict();
export type EvaluatorSpec = z.infer<typeof evaluatorSpecSchema>;

export function buildContainerArguments(
  spec: EvaluatorSpec,
  directory: string,
  name: string,
  manifestHash: string,
): string[] {
  if (directory.includes(",")) throw new Error("Container bind paths cannot contain commas");
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--label",
    `visp.runner.evaluation=${manifestHash}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--user",
    `${spec.uid}:${spec.gid}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--tmpfs",
    `/scratch:rw,nosuid,nodev,size=1g,uid=${spec.uid},gid=${spec.gid},mode=0700`,
    "--tmpfs",
    `/results:rw,nosuid,nodev,size=16m,uid=${spec.uid},gid=${spec.gid},mode=0700`,
    "--mount",
    `type=bind,src=${join(directory, "candidate")},dst=/candidate,readonly`,
    "--mount",
    `type=bind,src=${join(directory, "oracle")},dst=/evaluator,readonly`,
    "--workdir",
    "/scratch",
    "--entrypoint",
    "/bin/sh",
    spec.image,
    "-c",
    'report=$1; shift; "$@" > /scratch/evaluator.stdout 2> /scratch/evaluator.stderr; status=$?; cat /scratch/evaluator.stderr >&2; if [ -f "$report" ] && [ ! -L "$report" ]; then cat "$report"; fi; exit "$status"',
    "visp-evaluator",
    `/results/${spec.reportFile}`,
    ...spec.command,
  ];
}

export function evaluateReport(spec: EvaluatorSpec, report: unknown, exitCode: number | null) {
  const parsed = parseTestReport(spec.format, report);
  const passed = new Set(
    parsed.tests.filter((test) => test.status === "passed" && !test.flaky).map((test) => test.id),
  );
  const unmetTests = spec.requiredTests.filter((id) => !passed.has(id));
  return {
    report: parsed,
    unmetTests,
    accepted: exitCode === 0 && parsed.successful && !unmetTests.length,
  };
}

export async function evaluateRun(
  runDirectory: string,
  input: EvaluatorSpec,
  signal?: AbortSignal,
) {
  const spec = evaluatorSpecSchema.parse(input);
  const run = await inspectRun(runDirectory);
  const policyRoot = await realpath(spec.policyDirectory);
  assertOutside(run.manifest.spec.repository, policyRoot);
  assertOutside(run.manifest.worktree, policyRoot);
  const policy = await readPolicy(policyRoot);
  if (policy.hash !== spec.policyHash)
    throw new Error("Evaluator policy differs from its approved hash");
  const entrypoint = policy.files.find(
    (file) => file.path === spec.command[0]?.slice("/evaluator/".length),
  );
  if (!entrypoint?.executable)
    throw new Error("Pinned evaluator entrypoint must be an executable policy file");
  if (sha256(await readFile(spec.engine.executable)) !== spec.engine.executableSha256)
    throw new Error("Evaluator engine build drift");
  if (
    (await execute(spec.engine.executable, ["--version"], runDirectory, 10_000)).trim() !==
    spec.engine.version
  )
    throw new Error("Evaluator engine version drift");
  const directory = join(runDirectory, "evaluations", spec.id);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const manifest = {
    schemaVersion: 1,
    spec,
    runId: run.result.runId,
    resultHash: hashValue(run.result),
    sourceHash: run.result.snapshotHash,
    createdAt: new Date().toISOString(),
    provenance: "local-oci-execution",
  };
  const manifestHash = hashValue(manifest);
  immutableJson(join(directory, "manifest.json"), { manifest, hash: manifestHash });
  await materializeSource(runDirectory, join(directory, "candidate"), run.snapshot);
  await writePolicy(join(directory, "oracle"), policy.files);
  await mkdir(join(directory, "results"), { mode: 0o700 });
  const name = `visp-eval-${randomUUID()}`;
  const reportLines: string[] = [];
  const execution = await executeStream({
    file: spec.engine.executable,
    args: buildContainerArguments(spec, directory, name, manifestHash),
    cwd: directory,
    input: "",
    timeoutMs: spec.timeoutMs,
    signal,
    onLine: (line) => {
      reportLines.push(line);
      return undefined;
    },
  });
  await removeOwnedContainer(spec, name, manifestHash, directory);
  const reportPath = safeChild(join(directory, "results"), spec.reportFile);
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, reportLines.join("\n"), { flag: "wx", mode: 0o600 });
  let assessment: ReturnType<typeof evaluateReport> | null = null;
  let reportHash: string | null = null;
  let diagnostic: string | null = execution.error ?? null;
  try {
    await verifyMaterializedSource(join(directory, "candidate"), run.snapshot);
    if ((await realpath(reportPath)) !== reportPath || !(await lstat(reportPath)).isFile())
      throw new Error("Evaluator report is not a confined regular file");
    const bytes = await readFile(reportPath);
    if (bytes.length > 16 * 1024 * 1024)
      throw new Error("Evaluator report exceeds the output limit");
    reportHash = sha256(bytes);
    const text = bytes.toString("utf8");
    assessment = evaluateReport(
      spec,
      spec.format === "pytest" && text.trimStart().startsWith("<") ? text : JSON.parse(text),
      execution.exitCode,
    );
  } catch (cause) {
    diagnostic = cause instanceof Error ? cause.message : String(cause);
  }
  const receipt = {
    schemaVersion: 1,
    manifestHash,
    reportHash,
    assessment,
    status: evaluationStatus(execution.reason, diagnostic, assessment),
    execution: {
      exitCode: execution.exitCode,
      reason: execution.reason,
      stderrHash: sha256(execution.stderr),
    },
    diagnostic,
    endedAt: new Date().toISOString(),
    provenance: "local-oci-execution",
    authenticity: "requires-external-attestation",
  };
  immutableJson(join(directory, "receipt.json"), { receipt, hash: hashValue(receipt) });
  return receipt;
}

function evaluationStatus(
  reason: string,
  diagnostic: string | null,
  assessment: ReturnType<typeof evaluateReport> | null,
): "unchecked" | "accepted" | "rejected" {
  if (reason !== "exited" || diagnostic || !assessment) return "unchecked";
  return assessment.accepted ? "accepted" : "rejected";
}

async function removeOwnedContainer(
  spec: EvaluatorSpec,
  name: string,
  expected: string,
  cwd: string,
): Promise<void> {
  let owner: string;
  try {
    owner = (
      await execute(
        spec.engine.executable,
        ["inspect", "--format", '{{index .Config.Labels "visp.runner.evaluation"}}', name],
        cwd,
        5000,
      )
    ).trim();
  } catch {
    return;
  }
  if (owner === expected) await execute(spec.engine.executable, ["rm", "--force", name], cwd, 5000);
}

async function materializeSource(
  run: string,
  target: string,
  snapshot: SourceSnapshot,
): Promise<void> {
  await mkdir(target, { mode: 0o755 });
  for (const file of snapshot.files) {
    const destination = safeChild(target, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, await readFile(join(run, "objects", file.sha256)), {
      flag: "wx",
      mode: file.executable ? 0o555 : 0o444,
    });
  }
}

interface PolicyFile {
  path: string;
  content: Buffer;
  executable: boolean;
}
async function readPolicy(root: string) {
  const files: PolicyFile[] = [];
  let bytes = 0;
  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Evaluator policy cannot contain symlinks");
      if (entry.isDirectory()) await walk(absolute);
      else {
        const file = await readPolicyFile(root, absolute);
        bytes += file.content.length;
        if (bytes > 32 * 1024 * 1024 || files.length >= 1000)
          throw new Error("Evaluator policy exceeded its file/byte limit");
        files.push(file);
      }
    }
  };
  await walk(root);
  if (!files.length) throw new Error("Evaluator policy is empty");
  return {
    files,
    hash: hashValue(
      files.map((file) => ({
        path: file.path,
        sha256: sha256(file.content),
        executable: file.executable,
      })),
    ),
  };
}

async function readPolicyFile(root: string, absolute: string): Promise<PolicyFile> {
  const info = await lstat(absolute);
  if (!info.isFile()) throw new Error("Evaluator policy requires regular files");
  if (info.size > 32 * 1024 * 1024) throw new Error("Evaluator policy file exceeds its byte limit");
  return {
    path: absolute.slice(root.length + 1),
    content: await readFile(absolute),
    executable: Boolean(info.mode & 0o111),
  };
}

async function writePolicy(root: string, files: readonly PolicyFile[]): Promise<void> {
  await mkdir(root, { mode: 0o755 });
  for (const file of files) {
    const destination = safeChild(root, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, file.content, {
      flag: "wx",
      mode: file.executable ? 0o555 : 0o444,
    });
  }
}

export async function hashEvaluatorPolicy(directory: string): Promise<string> {
  return (await readPolicy(await realpath(directory))).hash;
}

export async function inspectEvaluation(runDirectory: string, id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id))
    throw new Error("Invalid evaluation identity");
  const run = await inspectRun(runDirectory);
  const directory = join(runDirectory, "evaluations", id);
  const envelope = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
    manifest: { spec: EvaluatorSpec; resultHash: string; sourceHash: string };
    hash: string;
  };
  const { manifest } = envelope;
  const spec = evaluatorSpecSchema.parse(manifest.spec);
  if (
    envelope.hash !== hashValue(manifest) ||
    manifest.resultHash !== hashValue(run.result) ||
    manifest.sourceHash !== run.result.snapshotHash
  ) {
    throw new Error("Evaluator manifest failed integrity verification");
  }
  if ((await hashEvaluatorPolicy(join(directory, "oracle"))) !== spec.policyHash)
    throw new Error("Pinned evaluator policy was modified");
  await verifyMaterializedSource(join(directory, "candidate"), run.snapshot);
  const result = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")) as {
    receipt: {
      manifestHash: string;
      reportHash: string | null;
      assessment: unknown;
      execution: { exitCode: number | null };
    };
    hash: string;
  };
  if (result.hash !== hashValue(result.receipt) || result.receipt.manifestHash !== envelope.hash)
    throw new Error("Evaluator receipt failed integrity verification");
  if (result.receipt.reportHash) {
    const bytes = await readFile(safeChild(join(directory, "results"), spec.reportFile));
    if (sha256(bytes) !== result.receipt.reportHash)
      throw new Error("Evaluator report failed integrity verification");
    const text = bytes.toString("utf8");
    const assessment = evaluateReport(
      spec,
      spec.format === "pytest" && text.trimStart().startsWith("<") ? text : JSON.parse(text),
      result.receipt.execution.exitCode,
    );
    if (hashValue(assessment) !== hashValue(result.receipt.assessment))
      throw new Error("Evaluator assessment disagrees with its report");
  }
  return result.receipt;
}

async function verifyMaterializedSource(root: string, snapshot: SourceSnapshot): Promise<void> {
  for (const file of snapshot.files) {
    const absolute = safeChild(root, file.path);
    if ((await realpath(absolute)) !== absolute || !(await lstat(absolute)).isFile())
      throw new Error("Evaluator source confinement changed");
    const bytes = await readFile(absolute);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
      throw new Error(`Evaluator source integrity changed: ${file.path}`);
  }
}
