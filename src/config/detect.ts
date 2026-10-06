import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { opendir } from "node:fs/promises";
import { extname, join } from "node:path";
import { DEFAULT_PRESET, HARD_IGNORED_DIRS, LIMITS, type Preset } from "../core/constants.js";
import { killCommandGroup } from "../core/exec.js";
import { ProjectFileSystem } from "../core/fs.js";

/**
 * Source counts select the language; markers distinguish frameworks and break
 * ties, including the zero-source case of a new project.
 */
export async function detectPreset(root: string): Promise<Preset> {
  const marker = await markerPreset(root);
  const counts = await sourceCounts(root);
  const maximum = Math.max(0, ...counts.values());
  if (maximum === 0) return marker;
  const leaders = [...counts.keys()].filter((language) => counts.get(language) === maximum);
  if (leaders.some((language) => matchesMarker(language, marker))) return marker;
  if (leaders.length > 1) {
    const tiedMarker = await markerPreset(root, leaders);
    if (leaders.some((language) => matchesMarker(language, tiedMarker))) return tiedMarker;
  }
  return leaders.sort()[0] ?? marker;
}

async function markerPreset(root: string, languages?: readonly SourceLanguage[]): Promise<Preset> {
  const files = new ProjectFileSystem(root);
  const manifest = await readPackageJson(root, files);
  const accepts = (preset: Preset) =>
    !languages || languages.some((language) => matchesMarker(language, preset));
  if (manifest) {
    const preset = await packagePreset(files, manifest);
    if (accepts(preset)) return preset;
  }

  if (
    accepts("python") &&
    (await existsAny(files, ["pyproject.toml", "requirements.txt", "setup.py"]))
  )
    return "python";
  if (accepts("go") && (await projectFileExists(files, "go.mod"))) return "go";
  if (accepts("rust") && (await projectFileExists(files, "Cargo.toml"))) return "rust";
  if (accepts("typescript") && (await projectFileExists(files, "tsconfig.json")))
    return "typescript";

  return DEFAULT_PRESET;
}

async function packagePreset(files: ProjectFileSystem, manifest: PackageManifest): Promise<Preset> {
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

type SourceLanguage = "typescript" | "javascript" | "python" | "go" | "rust";

const EXCLUDED_SOURCE_DIRS = new Set<string>([
  ...HARD_IGNORED_DIRS,
  "vendor",
  "static",
  "third_party",
  "js_tests",
  "fixtures",
  "test-fixtures",
  "test_fixtures",
]);

function sourceLanguage(path: string): SourceLanguage | undefined {
  if (
    path
      .split("/")
      .slice(0, -1)
      .some((part) => EXCLUDED_SOURCE_DIRS.has(part))
  )
    return undefined;
  if (path.endsWith(".min.js")) return undefined;
  switch (extname(path)) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    default:
      return undefined;
  }
}

function matchesMarker(language: SourceLanguage, marker: Preset): boolean {
  return (
    language === marker ||
    ((language === "javascript" || language === "typescript") &&
      (marker === "react" || marker === "node-api"))
  );
}

async function sourceCounts(root: string): Promise<Map<SourceLanguage, number>> {
  const tracked = await trackedSourceCounts(root);
  if (tracked) return tracked;
  const counts = new Map<SourceLanguage, number>();
  countSources(counts, await walkedSourcePaths(root));
  return counts;
}

function countSources(counts: Map<SourceLanguage, number>, paths: readonly string[]): void {
  for (const path of paths) {
    const language = sourceLanguage(path);
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
}

/** Stream the inventory: the shared command runner retains only diagnostic head/tail output. */
function trackedSourceCounts(root: string): Promise<Map<SourceLanguage, number> | undefined> {
  const deadline = Date.now() + 1_000;
  return new Promise<Map<SourceLanguage, number> | undefined>((resolve) => {
    const child = spawn("git", ["ls-files", "-z", "--", "."], {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const counts = new Map<SourceLanguage, number>();
    let pending = "";
    let ended = false;
    let finished = false;
    const finish = (complete: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killCommandGroup(child, "SIGKILL");
      child.stdout.destroy();
      resolve(complete && ended && pending === "" && Date.now() < deadline ? counts : undefined);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, deadline - Date.now()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (finished) return;
      if (Date.now() >= deadline) return finish(false);
      const paths = (pending + chunk).split("\0");
      pending = paths.pop() ?? "";
      // Bound an unterminated path as well as the total time spent reading.
      if (pending.length > 65_536) return finish(false);
      countSources(counts, paths);
    });
    child.stdout.once("end", () => {
      ended = true;
    });
    child.stdout.once("error", () => finish(false));
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  }).catch(() => undefined);
}

/** Count names only: init need not open source files or follow directory links. */
async function walkedSourcePaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const pending = [{ path: "", depth: 0 }];
  const deadline = Date.now() + 1_000;
  let visited = 0;
  while (pending.length && visited < LIMITS.maxFiles && Date.now() < deadline) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await boundedEntries(
      join(root, directory.path),
      LIMITS.maxFiles - visited,
      deadline,
    );
    visited += entries.length;
    for (const entry of entries) {
      const path = directory.path ? `${directory.path}/${entry.name}` : entry.name;
      if (entry.isFile()) paths.push(path);
      else if (isSourceDirectory(entry, directory.depth)) {
        pending.push({ path, depth: directory.depth + 1 });
      }
    }
  }
  return paths;
}

function isSourceDirectory(entry: Dirent, depth: number): boolean {
  return (
    entry.isDirectory() && depth < LIMITS.maxWalkDepth && !EXCLUDED_SOURCE_DIRS.has(entry.name)
  );
}

async function boundedEntries(
  path: string,
  remaining: number,
  deadline: number,
): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  try {
    for await (const entry of await opendir(path)) {
      if (entries.length >= remaining || Date.now() >= deadline) break;
      entries.push(entry);
    }
  } catch {
    // Unreadable directories cannot supply source-language evidence.
  }
  return entries;
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
