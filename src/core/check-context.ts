import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fromUnknown, type VispError, vispError } from "./errors.js";
import { resolvedProductExecutionEnvironment } from "./execution-environment.js";
import { err, type Result } from "./result.js";

export const PRODUCT_CHECK_CONTEXT = "VISP_PRODUCT_CHECK_CONTEXT";
interface CheckContext {
  root: string;
  check: string;
  receipt?: { directory: string; token: string };
}

function inheritedChecks(): CheckContext[] {
  try {
    const parsed: unknown = JSON.parse(process.env[PRODUCT_CHECK_CONTEXT] ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is CheckContext =>
            entry !== null &&
            typeof entry === "object" &&
            typeof entry.root === "string" &&
            typeof entry.check === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** Inherited by subprocesses, including ordinary test helpers that launch VISP indirectly. */
export async function productCheckEnvironment(
  root: string,
  check: string,
  receipt?: CheckContext["receipt"],
) {
  return {
    ...(await resolvedProductExecutionEnvironment()),
    [PRODUCT_CHECK_CONTEXT]: JSON.stringify([
      ...inheritedChecks(),
      { root: await realpath(root), check, receipt },
    ]),
  };
}

/** A denied child remains a failed check even when a wrapper swallows its exit code or output. */
export async function withProductCheckContext<T>(
  root: string,
  check: string,
  execute: (environment: Record<string, string>) => Promise<Result<T>>,
): Promise<Result<T>> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "visp-check-"));
  const context: CheckContext = {
    root: await realpath(root),
    check,
    receipt: { directory, token: randomUUID() },
  };
  let original: FileHandle | undefined;
  try {
    original = await open(join(directory, "receipt"), "wx+", 0o600);
    await original.writeFile(receiptHeader(context));
    const before = await original.stat();
    const result = await execute(await productCheckEnvironment(root, check, context.receipt));
    const current = await openCheckReceipt(context);
    try {
      const after = await current.stat();
      if (after.ino !== before.ino || after.dev !== before.dev)
        throw new Error("Check receipt changed");
      const text = await current.readFile("utf8");
      const header = receiptHeader(context);
      if (text === header) return result;
      if (text.startsWith(header) && /^(rejected\n)+$/.test(text.slice(header.length)))
        return err(recursiveCheckMutation(check));
      throw new Error("Check receipt changed");
    } finally {
      await current.close();
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(
      fromUnknown(
        `Check ${check}: execution receipt unavailable or changed: ${detail}`,
        "COMMAND_FAILED",
      ),
    );
  } finally {
    await original?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export function recursiveCheckMutation(check: string): VispError {
  return vispError(
    "ARTIFACT_INVALID",
    `Check ${check} cannot recursively mutate its VISP workflow while verification owns the state lock. Use a browser-journey check for runner-owned browser evidence, or run capture/review outside the command check.`,
    { details: { check, reason: "recursive-workflow-mutation" } },
  );
}

/** Guard before acquiring a lock; never make a child wait for its own parent verifier. */
export async function checkMutationGuard(canonicalRoot: string): Promise<VispError | undefined> {
  const context = await inheritedCheckFor(canonicalRoot);
  if (!context) return undefined;
  const rejected = recursiveCheckMutation(context.check);
  if (context.receipt) {
    let receipt: FileHandle | undefined;
    try {
      receipt = await openCheckReceipt(context);
      if ((await receipt.readFile("utf8")) === receiptHeader(context))
        await receipt.appendFile("rejected\n");
    } catch {
      // The parent treats a missing, redirected or changed receipt as an execution failure.
    } finally {
      await receipt?.close();
    }
  }
  return rejected;
}

/**
 * An inherited root may name the project through a symlink or, on Windows, a short name
 * (macOS temporary directories live under the /var symlink), so both sides are resolved.
 */
async function inheritedCheckFor(canonicalRoot: string): Promise<CheckContext | undefined> {
  for (const entry of inheritedChecks()) {
    if (entry.root === canonicalRoot) return entry;
    if ((await realpath(entry.root).catch(() => undefined)) === canonicalRoot) return entry;
  }
  return undefined;
}

function receiptHeader(context: CheckContext): string {
  return `${JSON.stringify({ version: 1, root: context.root, check: context.check, token: context.receipt?.token })}\n`;
}

/** Only a precreated, private, ordinary receipt file may receive a child refusal. */
async function openCheckReceipt(context: CheckContext): Promise<FileHandle> {
  const directory = context.receipt?.directory;
  if (
    typeof directory !== "string" ||
    typeof context.receipt?.token !== "string" ||
    dirname(directory) !== (await realpath(tmpdir())) ||
    !/^visp-check-[A-Za-z0-9]{6}$/.test(basename(directory))
  )
    throw new Error("Invalid check receipt directory");
  const folder = await lstat(directory);
  if (
    !folder.isDirectory() ||
    folder.isSymbolicLink() ||
    (folder.mode & 0o777) !== 0o700 ||
    directory !== (await realpath(directory))
  )
    throw new Error("Unsafe check receipt directory");
  const receipt = await open(
    join(directory, "receipt"),
    constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  try {
    const stat = await receipt.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 64 * 1024 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe check receipt file");
    return receipt;
  } catch (cause) {
    await receipt.close();
    throw cause;
  }
}
