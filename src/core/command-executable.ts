import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { hashValue } from "./hash.js";

const MAX_BYTES = 256 * 1024 * 1024;
const cache = new Map<string, { stamp: string; digest: string }>();

/** Observe the selected POSIX executable, not its interpreter, libraries or child processes. */
export async function commandExecutableDigest(
  binary: string,
  cwd: string,
  environment: Record<string, string>,
): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const candidates =
    isAbsolute(binary) || binary.includes("/")
      ? [resolve(cwd, binary)]
      : (environment.PATH ?? "/usr/bin:/bin")
          .split(delimiter)
          .map((entry) => resolve(cwd, entry, binary));
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      const info = await stat(path, { bigint: true });
      if (!info.isFile() || !(info.mode & 0o111n)) continue;
      await access(path, constants.X_OK);
      return await fingerprintExecutable(path, info);
    } catch {
      // Unavailable inputs yield no repair-comparison identity; normal spawn diagnostics remain.
    }
  }
  return undefined;
}

async function fingerprintExecutable(
  path: string,
  info: import("node:fs").BigIntStats,
): Promise<string | undefined> {
  try {
    if (info.size > BigInt(MAX_BYTES)) return undefined;
    const stamp = stampOf(info);
    const prior = cache.get(path);
    if (prior?.stamp === stamp) return prior.digest;
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) return undefined;
      hash.update(chunk);
    }
    if (stampOf(await stat(path, { bigint: true })) !== stamp) return undefined;
    const digest = hashValue({
      version: 1,
      path,
      mode: String(info.mode),
      content: hash.digest("hex"),
    });
    if (cache.size >= 128) cache.clear();
    cache.set(path, { stamp, digest });
    return digest;
  } catch {
    // A selected executable that cannot be read must not fall through to a later PATH entry.
    return undefined;
  }
}

function stampOf(info: import("node:fs").BigIntStats) {
  return [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":");
}
