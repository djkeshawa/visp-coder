import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileMutation } from "../../core/file-transaction.js";
import { filePrecondition } from "../../core/file-transaction.js";
import { ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";

/** Written by the Claude Code hook on every user prompt; git-ignored session state. */
export const HOST_PROMPTS_FILE = "user-prompts.jsonl";

export interface HostRequest {
  /** The request to preserve: a verbatim excerpt the worker quoted, or the latest prompt. */
  readonly request: string;
  readonly origin: "worker-quoted-host-prompt" | "host-prompt";
  /** Consumes the recorded prompts so the next feature starts from newer ones. */
  readonly mutation?: FileMutation;
}

/**
 * Weak workers paraphrase or summarize the user's request when they start a feature,
 * and the tester and reviewer then judge against the paraphrase. When the host recorded
 * the user's prompts, the worker's text is kept only if it is a verbatim excerpt of one.
 */
export async function hostRequest(
  workspace: WorkspaceState,
  workerText: string | undefined,
): Promise<Result<HostRequest | undefined>> {
  const path = join(workspace.paths.sessionDir, HOST_PROMPTS_FILE);
  const text = await workspace.files.readTextIfExists(path);
  if (!text.ok) return text;
  const recorded = text.value ? promptLines(text.value) : [];
  // Codex has no prompt hook, but commands see their session, which records user messages.
  const prompts = recorded.length ? recorded : await codexSessionPrompts();
  const latest = prompts.at(-1);
  if (!latest) return ok(undefined);
  const mutation: FileMutation | undefined =
    recorded.length && text.value
      ? { kind: "remove", path, expectedBefore: filePrecondition(text.value) }
      : undefined;
  const quoted = workerText?.trim();
  // A verbatim first sentence is still a summary; the quote must carry most of its prompt.
  if (
    quoted &&
    prompts.some(
      (prompt) =>
        normalized(prompt).includes(normalized(quoted)) &&
        normalized(quoted).length * 2 >= normalized(prompt).length,
    )
  )
    return ok({
      request: quoted,
      origin: "worker-quoted-host-prompt",
      ...(mutation ? { mutation } : {}),
    });
  return ok({ request: latest, origin: "host-prompt", ...(mutation ? { mutation } : {}) });
}

function promptLines(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    try {
      const prompt = (JSON.parse(line) as { prompt?: unknown }).prompt;
      return typeof prompt === "string" && prompt.trim() ? [prompt] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The user messages of the Codex session running this command: Codex sets CODEX_THREAD_ID
 * for commands and records the session as `sessions/<yyyy>/<mm>/<dd>/rollout-*-<id>.jsonl`.
 */
export async function codexSessionPrompts(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const thread = environment.CODEX_THREAD_ID;
  if (!thread || !/^[A-Za-z0-9-]+$/.test(thread)) return [];
  const home = environment.CODEX_HOME ?? join(homedir(), ".codex");
  const file = await findRollout(join(home, "sessions"), thread, 3);
  if (!file) return [];
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        payload?: { type?: string; item?: { type?: string; content?: { text?: unknown }[] } };
      };
      const item = event.payload?.item;
      if (event.type !== "event_msg" || item?.type !== "UserMessage") return [];
      const joined = (item.content ?? [])
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");
      return joined.trim() ? [joined] : [];
    } catch {
      return [];
    }
  });
}

async function findRollout(
  directory: string,
  thread: string,
  depth: number,
): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(`${thread}.jsonl`));
  if (match) return join(directory, match.name);
  if (depth === 0) return undefined;
  // Newest date directories first.
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))) {
    const found = await findRollout(join(directory, entry.name), thread, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
