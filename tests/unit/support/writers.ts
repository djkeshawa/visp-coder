/**
 * Direct writers for test setup. VISP writes these files through its installer and
 * workflow transactions; tests use these to arrange a state in one step.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Harness } from "../../../src/core/constants.js";
import { withStateMutation } from "../../../src/core/file-transaction.js";
import { ok, type Result } from "../../../src/core/result.js";
import {
  CLAUDE_SETTINGS_FILE,
  planPreToolUseRegistration,
} from "../../../src/harness/claude-settings.js";
import type { RegistrationStatus } from "../../../src/harness/mcp-registration.js";
import { mcpConfigFile, planMcpRegistration } from "../../../src/harness/mcp-registration.js";
import { now } from "../../../src/workflow/artifacts/common.js";
import type { Status } from "../../../src/workflow/artifacts/project.js";
import type { WorkspaceState } from "../../../src/workflow/state.js";
import { legacyStore } from "./legacy-store.js";

async function readIfExists(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

async function writePlanned(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function registerPreToolUseHook(
  root: string,
  hookPath: string,
  force: boolean,
): Promise<Result<RegistrationStatus>> {
  const path = join(root, CLAUDE_SETTINGS_FILE);
  const planned = planPreToolUseRegistration(await readIfExists(path), hookPath, force);
  if (!planned.ok) return planned;
  if (planned.value.content !== undefined) await writePlanned(path, planned.value.content);
  return ok(planned.value.status);
}

export async function registerMcpServer(
  root: string,
  force: boolean,
  harness: Harness = "claude-code",
): Promise<Result<RegistrationStatus>> {
  const path = join(root, mcpConfigFile(harness));
  const planned = planMcpRegistration(await readIfExists(path), force, harness);
  if (!planned.ok) return planned;
  if (planned.value.content !== undefined) await writePlanned(path, planned.value.content);
  return ok(planned.value.status);
}

export async function updateStatus(
  state: WorkspaceState,
  changes: Partial<Omit<Status, "kind" | "createdAt" | "updatedAt">>,
): Promise<Result<void>> {
  return withStateMutation(state.paths.root, async () => {
    const stored = await state.store.readStatusIfExists();
    if (!stored.ok) return stored;
    const current = stored.value ??
      state.status ?? { kind: "status" as const, createdAt: now(), updatedAt: now() };
    return legacyStore(state).writeStatus({ ...current, ...changes, updatedAt: now() });
  });
}
