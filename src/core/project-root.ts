import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Find the nearest initialized VISP project without crossing a Git boundary. */
export function initializedProjectRoot(start: string): string | undefined {
  let directory = resolve(start);
  while (true) {
    if (existsSync(join(directory, ".visp", "project.json"))) return directory;
    if (existsSync(join(directory, ".git"))) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function discoverProjectRoot(start: string): string {
  return initializedProjectRoot(start) ?? resolve(start);
}
