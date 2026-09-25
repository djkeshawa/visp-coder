import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const RUNTIME_FILES = ["package.json", "pnpm-lock.yaml", "tsconfig.json", "tsup.config.ts"];
const RUNTIME_DIRECTORIES = ["src"];

/** A deterministic identity for the inputs that can change the shipped runtime. */
export function computeBuildId(root: string): string {
  const paths = [
    ...RUNTIME_FILES.filter((path) => existsSync(join(root, path))),
    ...RUNTIME_DIRECTORIES.flatMap((path) => filesBelow(root, path)),
  ].sort();

  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(relative(root, join(root, path)).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function filesBelow(root: string, path: string): string[] {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [path];

  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesBelow(root, child) : [child];
  });
}
