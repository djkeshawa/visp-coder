import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/** Resolve launch aliases without starting a browser or inspecting a user's profile. */
export async function browserExecutableIdentity(
  binary = process.env.CHROME_BIN ?? "google-chrome",
): Promise<
  { path: string; size: number; mtime: number; mode: number } | { binary: string; missing: true }
> {
  const candidates =
    isAbsolute(binary) || binary.includes("/")
      ? [binary]
      : (process.env.PATH ?? "").split(delimiter).map((path) => join(path, binary));
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      const info = await stat(path);
      if (info.isFile() && info.mode & 0o111)
        return { path, size: info.size, mtime: info.mtimeMs, mode: info.mode };
    } catch {
      // Missing PATH entries are normal; retain a missing selector if none resolve.
    }
  }
  return { binary, missing: true };
}
