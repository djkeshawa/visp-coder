import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { type CommandOutput, run } from "../core/exec.js";
import { resolvedProductExecutionEnvironment } from "../core/execution-environment.js";
import { hashValue, sha256 } from "../core/hash.js";

export interface ControlSubject {
  readonly directory: string;
  /** The supervisor hashes real subject files before and after execution. */
  readonly files: readonly string[];
}
export interface SupervisedControl {
  readonly provenance: "supervisor-executed";
  readonly verifier: { readonly argv: readonly string[]; readonly sha256: string };
  readonly baseline: ControlExecution;
  readonly changed: ControlExecution;
  /** Sensitivity of this verifier only; does not prove the expectation matches the user's goal. */
  readonly detected: boolean;
}
export interface ControlExecution {
  readonly subjectDigest: string;
  readonly load: CommandOutput;
  readonly verification?: CommandOutput;
  readonly unchanged: boolean;
}

/** Runs the same pinned verifier in two distinct, still-loadable subject directories. */
export async function runSupervisedControl(options: {
  readonly baseline: ControlSubject;
  readonly changed: ControlSubject;
  readonly loadCommand: readonly [string, ...string[]];
  /** Absolute verifier script, invoked as [executable, verifierFile, ...args] in each subject. */
  readonly verifierFile: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}): Promise<SupervisedControl> {
  const [baseline, changed, verifierFile] = await Promise.all([
    realpath(options.baseline.directory),
    realpath(options.changed.directory),
    realpath(options.verifierFile),
  ]);
  if (within(baseline, changed) || within(changed, baseline))
    throw new Error("Control subjects must use distinct, non-nested directories");
  if (within(baseline, verifierFile) || within(changed, verifierFile))
    throw new Error("The shared verifier must be outside both mutable subjects");
  const verifierHash = sha256(await readFile(verifierFile));
  const argv: [string, ...string[]] = [
    options.executable ?? process.execPath,
    verifierFile,
    ...(options.args ?? []),
  ];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const environment = await resolvedProductExecutionEnvironment();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("timeoutMs must be positive and fit a timer");
  const base = await executeControlSubject(
    { ...options.baseline, directory: baseline },
    options.loadCommand,
    argv,
    timeoutMs,
    environment,
  );
  if (sha256(await readFile(verifierFile)) !== verifierHash)
    throw new Error("Verifier changed during baseline execution");
  const change = await executeControlSubject(
    { ...options.changed, directory: changed },
    options.loadCommand,
    argv,
    timeoutMs,
    environment,
  );
  if (sha256(await readFile(verifierFile)) !== verifierHash)
    throw new Error("Verifier changed during changed-subject execution");
  return {
    provenance: "supervisor-executed",
    verifier: { argv, sha256: verifierHash },
    baseline: base,
    changed: change,
    detected:
      base.subjectDigest !== change.subjectDigest &&
      base.unchanged &&
      change.unchanged &&
      passed(base.load) &&
      passed(change.load) &&
      base.verification !== undefined &&
      passed(base.verification) &&
      change.verification !== undefined &&
      !change.verification.timedOut &&
      change.verification.exitCode !== 0,
  };
}

async function executeControlSubject(
  subject: ControlSubject,
  loadCommand: readonly [string, ...string[]],
  argv: readonly [string, ...string[]],
  timeoutMs: number,
  env: Record<string, string>,
): Promise<ControlExecution> {
  const subjectDigest = await digestSubject(subject);
  const execute = async (command: readonly [string, ...string[]]) => {
    const result = await run(command[0], command.slice(1), {
      cwd: subject.directory,
      timeoutMs,
      env,
      replaceEnv: true,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const load = await execute(loadCommand);
  const verification = passed(load) ? await execute(argv) : undefined;
  return {
    subjectDigest,
    load,
    ...(verification ? { verification } : {}),
    unchanged: subjectDigest === (await digestSubject(subject)),
  };
}

async function digestSubject(subject: ControlSubject): Promise<string> {
  if (!subject.files.length) throw new Error("Control subjects must declare actual source files");
  const files: Array<{ path: string; sha256: string }> = [];
  for (const path of [...new Set(subject.files)].sort()) {
    if (isAbsolute(path)) throw new Error("Control source paths must be relative");
    const absolute = await realpath(resolve(subject.directory, path));
    if (!within(subject.directory, absolute)) throw new Error("Control source escapes its subject");
    files.push({ path, sha256: sha256(await readFile(absolute)) });
  }
  return hashValue(files);
}
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}
function passed(output: CommandOutput): boolean {
  return output.exitCode === 0 && !output.timedOut;
}
