import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { parse } from "yaml";
import { parseProjectFilePath } from "../core/input.js";
import type { WorkspaceState } from "../workflow/state.js";

const MAX_INPUT_BYTES = 1024 * 1024;

/** Transient input shares the confined file parser; it never becomes a product file. */
export async function readCommandInput(
  state: WorkspaceState,
  path: string,
  input: Readable & { isTTY?: boolean } = process.stdin,
): Promise<unknown> {
  const bytes = path === "-" ? await readStandardInput(input) : await readInputFile(state, path);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error("Command input exceeds 1 MiB");
  if (!bytes.toString("utf8").trim()) throw new Error("Command input is empty");
  return parse(bytes.toString("utf8"), { maxAliasCount: 50 });
}

async function readInputFile(state: WorkspaceState, path: string): Promise<Buffer> {
  // Workers keep drafts in the temporary directory; reading their own input there is safe.
  const temporary = resolve(path);
  if (isAbsolute(path) && temporary.startsWith(`${resolve(tmpdir())}${sep}`)) {
    const bytes = await readFile(temporary);
    if (bytes.length > MAX_INPUT_BYTES) throw new Error("Command input exceeds 1 MiB");
    return bytes;
  }
  const checked = parseProjectFilePath(isAbsolute(path) ? relative(state.paths.root, path) : path);
  // Workers kept drafts in /tmp; stdin reaches the same input without a project file.
  if (!checked.ok)
    throw new Error(`${checked.error.message}. For a file elsewhere, pipe it: --from - < ${path}`);
  const metadata = await state.files.readMetadata(checked.value);
  if (!metadata.ok) throw new Error(metadata.error.message);
  if (!metadata.value) throw new Error(`Command input not found: ${path}`);
  if (metadata.value.type !== "file") throw new Error("Command input must be a regular file");
  if (metadata.value.size > MAX_INPUT_BYTES) throw new Error("Command input exceeds 1 MiB");
  const result = await state.files.readBytes(checked.value);
  if (!result.ok) throw new Error(result.error.message);
  return Buffer.from(result.value);
}

/** A stalled producer cannot keep a workflow command alive indefinitely. */
export function readStandardInput(
  input: Readable & { isTTY?: boolean } = process.stdin,
  timeoutMs = 10_000,
): Promise<Buffer> {
  if (input.isTTY) return Promise.reject(new Error("Pipe YAML or JSON to --from -"));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => finish(new Error("Standard input timed out")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      input.off("data", data);
      input.off("end", end);
      input.off("error", finish);
      input.off("close", closed);
      input.pause();
    };
    const finish = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT_BYTES) finish(new Error("Command input exceeds 1 MiB"));
      else chunks.push(bytes);
    };
    const end = () => {
      cleanup();
      if (!size) reject(new Error("Command input is empty"));
      else resolve(Buffer.concat(chunks, size));
    };
    const closed = () => finish(new Error("Standard input closed before completion"));
    input.on("data", data);
    input.once("end", end);
    input.once("error", finish);
    input.once("close", closed);
    if (input.readableEnded) end();
    else input.resume();
  });
}
