import { isDeepStrictEqual } from "node:util";
import { ProjectFileSystem } from "../core/fs.js";
import { ok, type Result } from "../core/result.js";

/**
 * Registers the PreToolUse hook in the project's `.claude/settings.json`,
 * merging into whatever is already there. Writing the hook script without
 * wiring it up installs nothing: Claude Code only runs hooks this file names,
 * so leaving the wiring to the user means the enforcement surface is off by
 * default and no one finds out.
 *
 * Other hooks are left untouched, on the same reasoning as `mcp-registration`:
 * clobbering a project's configuration to add one entry is a poor trade.
 */

export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";
export const CLAUDE_PRE_TOOL_USE_HOOK = ".visp/hooks/claude-pretooluse.mjs";

/** Tools that write files, and so must be checked before they run. */
export const PRE_TOOL_USE_MATCHER = "Edit|Write|NotebookEdit";

export type RegistrationStatus = "added" | "current" | "customized" | "replaced" | "malformed";

/** Whether the wiring is in place, for `doctor` to report. */
export type RegistrationState = "present" | "absent" | "customized" | "malformed";

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: { PreToolUse?: HookEntry[]; UserPromptSubmit?: unknown; [event: string]: unknown };
  [key: string]: unknown;
}

/** The command Claude Code runs. Relative to the project, so it survives a move. */
export function hookCommand(hookPath: string): string {
  return `node "$CLAUDE_PROJECT_DIR/${hookPath}"`;
}

/**
 * The same script records each user prompt, so `visp feature` has the verbatim request,
 * and on Stop sends a worker back to an unfinished feature. `visp next` may wait for a
 * running review, so Stop gets a longer timeout than the 60 s default.
 */
function sessionEntries(hookPath: string): Record<"UserPromptSubmit" | "Stop", HookEntry> {
  return {
    UserPromptSubmit: { hooks: [{ type: "command", command: hookCommand(hookPath) }] },
    Stop: { hooks: [{ type: "command", command: hookCommand(hookPath), timeout: 180 }] },
  };
}

/** Shell commands that would delete VISP state are checked by the same script. */
function shellEntryFor(hookPath: string): HookEntry {
  return { matcher: "Bash", hooks: [{ type: "command", command: hookCommand(hookPath) }] };
}

/** Other hooks for these events stay; VISP's own entries are replaced by generated ones. */
function withPromptHook(settings: ClaudeSettings, hookPath: string): ClaudeSettings {
  const hooks: Record<string, unknown> = { ...(settings.hooks ?? {}) };
  for (const [event, expected] of Object.entries(sessionEntries(hookPath))) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as HookEntry[]) : [];
    hooks[event] = [...current.filter((entry) => !referencesHook(entry, hookPath)), expected];
  }
  const tools = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as HookEntry[]) : [];
  const shell = shellEntryFor(hookPath);
  hooks.PreToolUse = [...tools.filter((entry) => !isDeepStrictEqual(entry, shell)), shell];
  return { ...settings, hooks: hooks as ClaudeSettings["hooks"] };
}

function withoutPromptHook(settings: ClaudeSettings, hookPath: string): ClaudeSettings {
  const hooks: Record<string, unknown> = { ...(settings.hooks ?? {}) };
  for (const [event, expected] of Object.entries(sessionEntries(hookPath))) {
    if (!Array.isArray(hooks[event])) continue;
    const remaining = (hooks[event] as HookEntry[]).filter(
      (entry) => !isDeepStrictEqual(entry, expected),
    );
    if (remaining.length) hooks[event] = remaining;
    else delete hooks[event];
  }
  if (Array.isArray(hooks.PreToolUse)) {
    const shell = shellEntryFor(hookPath);
    hooks.PreToolUse = (hooks.PreToolUse as HookEntry[]).filter(
      (entry) => !isDeepStrictEqual(entry, shell),
    );
  }
  return { ...settings, hooks: hooks as ClaudeSettings["hooks"] };
}

function hasPromptHook(settings: ClaudeSettings, hookPath: string): boolean {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const shell = shellEntryFor(hookPath);
  const tools = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as HookEntry[]) : [];
  if (!tools.some((entry) => isDeepStrictEqual(entry, shell))) return false;
  return Object.entries(sessionEntries(hookPath)).every(
    ([event, expected]) =>
      Array.isArray(hooks[event]) &&
      (hooks[event] as HookEntry[]).some((entry) => isDeepStrictEqual(entry, expected)),
  );
}

function entryFor(hookPath: string): HookEntry {
  return {
    matcher: PRE_TOOL_USE_MATCHER,
    hooks: [{ type: "command", command: hookCommand(hookPath) }],
  };
}

export interface PlannedClaudeRegistration {
  readonly status: RegistrationStatus;
  readonly content?: string;
}

export type UnregistrationStatus = "absent" | "removed" | "customized" | "malformed";

export interface PlannedClaudeUnregistration {
  readonly status: UnregistrationStatus;
  readonly content?: string;
}

export interface PreToolUseResidue {
  readonly exact: boolean;
  readonly customized: boolean;
  readonly malformed: boolean;
}

/** Pure registration merge for transactional installers. */
export function planPreToolUseRegistration(
  current: string | undefined,
  hookPath: string,
  force: boolean,
): Result<PlannedClaudeRegistration> {
  const parsed = parseSettings(current);

  if (parsed === "malformed") {
    // Rewriting a file we cannot parse would discard whatever it holds.
    return force
      ? ok({
          status: "replaced",
          content: formatSettings(
            withPromptHook({ hooks: { PreToolUse: [entryFor(hookPath)] } }, hookPath),
          ),
        })
      : ok({ status: "malformed" });
  }

  const settings = parsed;
  const existing = preToolUseEntries(settings);
  if (existing === "malformed") {
    return force
      ? ok({
          status: "replaced",
          content: formatSettings(
            withPromptHook({ ...settings, hooks: { PreToolUse: [entryFor(hookPath)] } }, hookPath),
          ),
        })
      : ok({ status: "malformed" });
  }
  const expected = entryFor(hookPath);
  const exact = existing.findIndex((entry) => isDeepStrictEqual(entry, expected));
  if (exact !== -1)
    return hasPromptHook(settings, hookPath)
      ? ok({ status: "current" })
      : ok({ status: "replaced", content: formatSettings(withPromptHook(settings, hookPath)) });

  const mine = existing.findIndex((entry) => referencesHook(entry, hookPath));
  if (mine !== -1 && !force) return ok({ status: "customized" });

  const next = [...existing];
  if (mine === -1) next.push(expected);
  else next[mine] = expected;

  return ok({
    status: mine === -1 ? "added" : "replaced",
    content: formatSettings(
      withPromptHook(
        { ...settings, hooks: { ...(settings.hooks ?? {}), PreToolUse: next } },
        hookPath,
      ),
    ),
  });
}

/** Removes only byte-for-byte generated VISP entries from Claude settings. */
export function planPreToolUseUnregistration(
  current: string | undefined,
  hookPath: string,
): PlannedClaudeUnregistration {
  const parsed = parseSettings(current);
  if (parsed === "malformed") return { status: "malformed" };
  const existing = preToolUseEntries(parsed);
  if (existing === "malformed") return { status: "malformed" };

  const expected = entryFor(hookPath);
  const exact = existing.filter((entry) => isDeepStrictEqual(entry, expected));
  if (exact.length === 0) {
    return {
      status: existing.some((entry) => referencesHook(entry, hookPath)) ? "customized" : "absent",
    };
  }

  return {
    status: "removed",
    content: formatSettings(
      withoutPromptHook(
        {
          ...parsed,
          hooks: {
            ...(parsed.hooks ?? {}),
            PreToolUse: existing.filter((entry) => !isDeepStrictEqual(entry, expected)),
          },
        },
        hookPath,
      ),
    ),
  };
}

/** Distinguishes removable generated entries from project-customized references. */
export function inspectPreToolUseResidue(
  current: string | undefined,
  hookPath: string,
): PreToolUseResidue {
  const parsed = parseSettings(current);
  if (parsed === "malformed") return { exact: false, customized: false, malformed: true };
  const existing = preToolUseEntries(parsed);
  if (existing === "malformed") return { exact: false, customized: false, malformed: true };

  const expected = entryFor(hookPath);
  return {
    exact: existing.some((entry) => isDeepStrictEqual(entry, expected)),
    customized: existing.some(
      (entry) => !isDeepStrictEqual(entry, expected) && referencesHook(entry, hookPath),
    ),
    malformed: false,
  };
}

/** Reports whether the hook is wired, without changing anything. */
export async function preToolUseRegistration(
  root: string,
  hookPath: string,
): Promise<Result<RegistrationState>> {
  const current = await new ProjectFileSystem(root).readTextIfExists(CLAUDE_SETTINGS_FILE);
  if (!current.ok) return current;
  const residue = inspectPreToolUseResidue(current.value, hookPath);
  if (residue.malformed) return ok("malformed");
  if (residue.exact) return ok("present");
  return ok(residue.customized ? "customized" : "absent");
}

/**
 * A path reference identifies an edited VISP entry for conflict reporting.
 * It never establishes health: only the exact generated entry is active.
 */
function referencesHook(entry: HookEntry, hookPath: string): boolean {
  return Array.isArray(entry.hooks)
    ? entry.hooks.some(
        (hook) => typeof hook?.command === "string" && hook.command.includes(hookPath),
      )
    : false;
}

function preToolUseEntries(settings: ClaudeSettings): HookEntry[] | "malformed" {
  const hooks = settings.hooks;
  if (hooks === undefined) return [];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return "malformed";
  const entries = hooks.PreToolUse;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return "malformed";
  return entries.every(
    (entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry),
  )
    ? (entries as HookEntry[])
    : "malformed";
}

function parseSettings(current: string | undefined): ClaudeSettings | "malformed" {
  if (current === undefined || current.trim() === "") return {};

  try {
    const value = JSON.parse(current) as unknown;
    // A JSON array or scalar parses but is not a settings object.
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "malformed";
    return value as ClaudeSettings;
  } catch {
    return "malformed";
  }
}

function formatSettings(settings: ClaudeSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
