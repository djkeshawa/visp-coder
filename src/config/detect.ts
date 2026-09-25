import { DEFAULT_PRESET, type Preset } from "../core/constants.js";
import { ProjectFileSystem } from "../core/fs.js";

/**
 * Infers the project preset from marker files. Ordered from most to least
 * specific, so a React app is not merely "typescript".
 */
export async function detectPreset(root: string): Promise<Preset> {
  const files = new ProjectFileSystem(root);
  const manifest = await readPackageJson(root, files);

  if (manifest) {
    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    if ("react" in dependencies || "next" in dependencies) return "react";
    if (hasAny(dependencies, ["express", "fastify", "koa", "@nestjs/core", "hono"])) {
      return "node-api";
    }
    if ("typescript" in dependencies || (await projectFileExists(files, "tsconfig.json"))) {
      return "typescript";
    }
    return "javascript";
  }

  if (await existsAny(files, ["pyproject.toml", "requirements.txt", "setup.py"])) return "python";
  if (await projectFileExists(files, "go.mod")) return "go";
  if (await projectFileExists(files, "Cargo.toml")) return "rust";
  if (await projectFileExists(files, "tsconfig.json")) return "typescript";

  return DEFAULT_PRESET;
}

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
}

export async function readPackageJson(
  root: string,
  files = new ProjectFileSystem(root),
): Promise<PackageManifest | undefined> {
  const text = await files.readTextIfExists("package.json");
  if (!text.ok || text.value === undefined) return undefined;
  try {
    return JSON.parse(text.value) as PackageManifest;
  } catch {
    return undefined;
  }
}

function hasAny(dependencies: Record<string, string>, names: readonly string[]): boolean {
  return names.some((name) => name in dependencies);
}

async function existsAny(files: ProjectFileSystem, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if (await projectFileExists(files, name)) return true;
  }
  return false;
}

async function projectFileExists(files: ProjectFileSystem, path: string): Promise<boolean> {
  const present = await files.exists(path);
  return present.ok && present.value;
}
