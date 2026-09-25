import { HARNESSES, type Harness, PROFILES } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import { ProjectFileSystem } from "../core/fs.js";
import { sha256 } from "../core/hash.js";
import type { ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import {
  CLAUDE_PRE_TOOL_USE_HOOK,
  CLAUDE_SETTINGS_FILE,
  inspectPreToolUseResidue,
} from "./claude-settings.js";
import type { AssetManifest } from "./install-types.js";
import {
  mcpConfigFile as configFileForHarness,
  inspectMcpRegistrationResidue,
  MCP_CONFIG_FILE,
} from "./mcp-registration.js";
import { planFor } from "./targets.js";

export const CLAUDE_SETTINGS_REGISTRATION = `${CLAUDE_SETTINGS_FILE} (VISP PreToolUse registration)`;

export interface ForeignHarnessAssets {
  /** Existing assets whose bytes match VISP's recorded manifest. */
  readonly owned: string[];
  /** Previously owned assets whose bytes have since changed. */
  readonly edited: string[];
  /** Files at another harness's VISP path without a recorded fingerprint. */
  readonly unrecognized: string[];
  /** An exact generated VISP PreToolUse registration in Claude settings. */
  readonly claudeRegistration: boolean;
  /** Exact generated VISP MCP registrations in config files unused by the selected harness. */
  readonly mcpRegistrations: readonly ForeignMcpRegistration[];
}

export type McpRegistrationHarness = "claude-code" | "codex" | "opencode";

export interface ForeignMcpRegistration {
  readonly harness: McpRegistrationHarness;
  readonly path: string;
}

export async function inspectForeignHarnessAssets(
  paths: ProjectPaths,
  harness: Harness,
  providedManifest?: AssetManifest,
): Promise<Result<ForeignHarnessAssets>> {
  const fs = new ProjectFileSystem(paths.root);
  const loaded = providedManifest ? ok(providedManifest) : await readAssetManifest(paths, fs);
  if (!loaded.ok) return loaded;
  const inspected = await inspectForeignAssetFiles(fs, foreignAssetPaths(harness), loaded.value);
  if (!inspected.ok) return inspected;
  const claude =
    harness === "claude-code"
      ? ok(inspected.value.residue)
      : await inspectPreviousClaudeRegistration(fs, loaded.value, inspected.value);
  if (!claude.ok) return claude;
  return inspectPreviousMcpRegistrations(fs, harness, claude.value);
}

function foreignAssetPaths(harness: Harness): string[] {
  const keep = new Set(
    PROFILES.flatMap((candidate) => planFor(harness, candidate).assets.map((asset) => asset.path)),
  );
  const candidates = new Set(
    HARNESSES.filter((candidate) => candidate !== harness).flatMap((candidate) =>
      PROFILES.flatMap((candidateProfile) =>
        planFor(candidate, candidateProfile).assets.map((asset) => asset.path),
      ),
    ),
  );
  if (harness !== "claude-code") candidates.add(CLAUDE_PRE_TOOL_USE_HOOK);
  return [...candidates].filter((path) => !keep.has(path)).sort();
}

interface InspectedForeignFiles {
  readonly residue: ForeignHarnessAssets;
  readonly claudeHookExists: boolean;
}

async function inspectForeignAssetFiles(
  fs: ProjectFileSystem,
  paths: readonly string[],
  manifest: AssetManifest,
): Promise<Result<InspectedForeignFiles>> {
  const found: ForeignHarnessAssets = {
    owned: [],
    edited: [],
    unrecognized: [],
    claudeRegistration: false,
    mcpRegistrations: [],
  };
  let claudeHookExists = false;
  for (const path of paths) {
    const current = await fs.readTextIfExists(path);
    if (!current.ok) return current;
    if (current.value === undefined) continue;
    if (path === CLAUDE_PRE_TOOL_USE_HOOK) claudeHookExists = true;
    classifyForeignAsset(found, manifest, path, current.value);
  }
  return ok({ residue: found, claudeHookExists });
}

function classifyForeignAsset(
  found: ForeignHarnessAssets,
  manifest: AssetManifest,
  path: string,
  content: string,
): void {
  const recorded = manifest[path];
  const bucket =
    recorded === undefined
      ? found.unrecognized
      : recorded === assetFingerprint(content)
        ? found.owned
        : found.edited;
  bucket.push(path);
}

async function inspectPreviousClaudeRegistration(
  fs: ProjectFileSystem,
  manifest: AssetManifest,
  inspected: InspectedForeignFiles,
): Promise<Result<ForeignHarnessAssets>> {
  const settings = await fs.readTextIfExists(CLAUDE_SETTINGS_FILE);
  if (!settings.ok) return settings;
  const registration = inspectPreToolUseResidue(settings.value, CLAUDE_PRE_TOOL_USE_HOOK);
  if (registration.customized) {
    inspected.residue.edited.push(CLAUDE_SETTINGS_REGISTRATION);
  }
  const hasHookHistory =
    inspected.claudeHookExists || manifest[CLAUDE_PRE_TOOL_USE_HOOK] !== undefined;
  if (registration.malformed && hasHookHistory) {
    inspected.residue.unrecognized.push(CLAUDE_SETTINGS_REGISTRATION);
  }
  return ok({ ...inspected.residue, claudeRegistration: registration.exact });
}

async function inspectPreviousMcpRegistrations(
  fs: ProjectFileSystem,
  harness: Harness,
  residue: ForeignHarnessAssets,
): Promise<Result<ForeignHarnessAssets>> {
  const exact: ForeignMcpRegistration[] = [];
  for (const candidate of foreignMcpRegistrationCandidates(harness)) {
    const registration = await inspectMcpRegistrationCandidate(fs, candidate);
    if (!registration.ok) return registration;
    const label = mcpRegistrationLabel(candidate.path);
    if (registration.value.exact) exact.push(candidate);
    if (registration.value.customized) residue.edited.push(label);
    if (registration.value.malformed) residue.unrecognized.push(label);
  }
  return ok({ ...residue, mcpRegistrations: exact });
}

async function inspectMcpRegistrationCandidate(
  fs: ProjectFileSystem,
  candidate: ForeignMcpRegistration,
): Promise<
  Result<{ readonly exact: boolean; readonly customized: boolean; readonly malformed: boolean }>
> {
  const current = await fs.readTextIfExists(candidate.path);
  if (!current.ok) return current;
  return ok(inspectMcpRegistrationResidue(current.value, candidate.harness));
}

function foreignMcpRegistrationCandidates(harness: Harness): ForeignMcpRegistration[] {
  const candidates = foreignMcpRegistrationHarnesses(harness).map((candidate) => ({
    harness: candidate,
    path: configFileForHarness(candidate),
  }));
  if (harness === "codex" || harness === "opencode") {
    candidates.push({ harness: "claude-code", path: MCP_CONFIG_FILE });
  }
  return candidates;
}

function foreignMcpRegistrationHarnesses(harness: Harness): McpRegistrationHarness[] {
  if (harness === "opencode") return ["codex"];
  if (harness === "codex") return ["opencode"];
  if (["claude-code", "cursor"].includes(harness)) return ["codex", "opencode"];
  return ["codex", "opencode"];
}

export function mcpRegistrationLabel(path: string): string {
  return `${path} (VISP MCP registration)`;
}

export function assetFingerprint(content: string): string {
  return sha256(content).slice(0, 12);
}

export async function readAssetManifest(
  paths: ProjectPaths,
  fs = new ProjectFileSystem(paths.root),
): Promise<Result<AssetManifest>> {
  const stored = await fs.readJsonIfExists(paths.assetManifest, parseAssetManifest);
  if (!stored.ok) return stored;
  return ok(stored.value ?? {});
}

export function parseAssetManifestText(content: string | undefined): Result<AssetManifest> {
  if (content === undefined) return ok({});
  try {
    return parseAssetManifest(JSON.parse(content));
  } catch {
    return err(vispError("ARTIFACT_INVALID", "The harness asset manifest is not valid JSON"));
  }
}

function parseAssetManifest(value: unknown): Result<AssetManifest> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(vispError("ARTIFACT_INVALID", "The harness asset manifest is malformed"));
  }
  const entries = Object.entries(value);
  if (entries.some(([, fingerprint]) => typeof fingerprint !== "string")) {
    return err(vispError("ARTIFACT_INVALID", "The harness asset manifest is malformed"));
  }
  return ok(Object.fromEntries(entries) as AssetManifest);
}
