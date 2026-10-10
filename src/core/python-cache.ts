import { lstat, mkdir, realpath } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { isNodeError } from "./errors.js";
import { sha256 } from "./hash.js";

/** Never import bytecode from a shared cache another account can populate. */
export async function pythonCacheDirectory(): Promise<string> {
  const user = process.getuid?.() ?? sha256(userInfo().username).slice(0, 16);
  const path = join(await realpath(tmpdir()), `visp-python-cache-${user}`);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (cause) {
    if (!isNodeError(cause) || cause.code !== "EEXIST") throw cause;
  }
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error(
      `Unsafe Python cache directory: ${path}; remove or repair its ownership and permissions`,
    );
  return path;
}
