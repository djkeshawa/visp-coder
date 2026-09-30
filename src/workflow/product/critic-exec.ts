import { lookup as dnsLookup } from "node:dns/promises";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { run as execRun } from "../../core/exec.js";
import { redactStrings } from "../../core/redaction.js";
import { sweepStaleTempDirectories } from "../../core/stale-temp.js";
import type { ProductCriticHost } from "./critic.js";
import type { CriticPacket } from "./critic-packet.js";

/**
 * VISP launches the reviewer itself: one ephemeral `codex exec` per reserved call, with a
 * read-only sandbox, no user config or personal skills, and the packet's response schema.
 * Weak actors did not run the host-orchestrated preflight/prepare/submit protocol, so the
 * critic never reviewed their work. The project opts in with `critic.launch: codex-exec`,
 * which is the delegation authorization this adapter reports.
 */
export function codexExecCriticHost(options: {
  root: string;
  executable?: string;
  /** Resolves a model endpoint; injectable so tests need no network. */
  lookup?: (host: string) => Promise<unknown>;
  /** Live web search for public documentation; every query is logged for the reviewer. */
  webSearch?: boolean;
}): ProductCriticHost {
  const executable = options.executable ?? "codex";
  const lookup = options.lookup ?? ((host: string) => dnsLookup(host));
  return {
    async inspect(config) {
      if (config.harness !== "codex")
        return { unavailable: "critic.launch: codex-exec requires critic.harness: codex" };
      const version = await run(executable, ["--version"], { signal: config.signal });
      if (version.exitCode !== 0)
        return {
          unavailable: `Codex CLI is not runnable${process.platform === "win32" ? " (check the npm codex.cmd shim and PATH)" : ""}: ${version.error ?? version.stderr}`,
        };
      if (!(await reachesModel(lookup)))
        return {
          unavailable:
            "The reviewer cannot reach its model from this process; the host sandbox likely blocks network. Rerun visp done with sandbox escalation. No review call was spent.",
        };
      return {
        harness: "codex",
        model: config.model,
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        freshContext: true,
        images: true,
        readOnly: true,
        delegationAllowed: true,
      };
    },
    async review(packet, config) {
      // Directories from reviews that were killed before they could clean up hold a copy of
      // the sign-in; a review takes minutes, so an hour-old one is abandoned.
      await sweepStaleTempDirectories(STALE_REVIEW_NAMES, STALE_REVIEW_MS);
      const directory = await mkdtemp(join(tmpdir(), "visp-critic-"));
      try {
        const images = await writeImages(directory, packet);
        const response = await runCodexStructured({
          executable,
          root: options.root,
          directory,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          schema: packet.responseSchema,
          prompt: reviewerPrompt(images.packet, options.webSearch === true),
          images: images.paths,
          signal: config.signal,
          webSearch: options.webSearch === true,
          onActivity: (activity) => recordActivity(options.root, packet, config.model, activity),
        });
        // Codex refuses an unknown model or effort, so a zero exit ran the configured pair.
        return {
          model: config.model,
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
          context: "fresh" as const,
          response,
        };
      } finally {
        await rm(directory, REMOVE_TEMPORARY);
      }
    },
  };
}

/** Exactly what `mkdtemp` makes (prefix plus six characters), so named directories survive. */
const STALE_REVIEW_NAMES = [/^visp-(?:critic|review)-[A-Za-z0-9]{6}$/];
const STALE_REVIEW_MS = 60 * 60_000;
/** The child may still be releasing files as it dies, so removal retries briefly. */
const REMOVE_TEMPORARY = { recursive: true, force: true, maxRetries: 4, retryDelay: 100 } as const;

/**
 * One read-only, ephemeral `codex exec` session in the project that answers `prompt` with
 * JSON matching `schema`. Used by the reviewer and by the independent tester; `directory`
 * is a private temporary directory the caller removes.
 */
export async function runCodexStructured(options: {
  executable?: string;
  root: string;
  directory: string;
  model: string;
  reasoningEffort?: string;
  schema: unknown;
  prompt: string;
  images?: readonly string[];
  signal?: AbortSignal;
  /** Allow the session's live web search; every query is reported through `onActivity`. */
  webSearch?: boolean;
  /** A writable sandbox (with network) for a disposable copy; read-only by default. */
  sandbox?: "read-only" | "workspace-write";
  network?: boolean;
  onActivity?: (activity: SessionActivity) => void | Promise<void>;
}): Promise<unknown> {
  const schemaPath = join(options.directory, "schema.json");
  const responsePath = join(options.directory, "response.json");
  await writeFile(schemaPath, JSON.stringify(options.schema));
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    options.sandbox ?? "read-only",
    // With network on, the session's commands get only core variables (PATH, HOME, ...),
    // so tokens and credentials in the operator's environment cannot leave the machine.
    ...(options.network
      ? [
          "--config",
          "sandbox_workspace_write.network_access=true",
          "--config",
          'shell_environment_policy.inherit="core"',
        ]
      : []),
    "--cd",
    options.root,
    "--model",
    options.model,
    ...(options.reasoningEffort
      ? ["--config", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`]
      : []),
    ...(options.webSearch ? ["--config", 'web_search="live"'] : []),
    ...(options.images ?? []).flatMap((path) => ["--image", path]),
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    responsePath,
    "-",
  ];
  const codexHome = await privateCodexHome(options.directory);
  const termination = forwardTermination(options.signal);
  let result: RunResult;
  try {
    result = await run(options.executable ?? "codex", args, {
      signal: termination.signal,
      stdin: options.prompt,
      env: { CODEX_HOME: codexHome },
    });
  } finally {
    // The sign-in copy goes as soon as the process group is gone, not when the caller's
    // directory is removed: the tester's directory lives for the whole session.
    await rm(codexHome, REMOVE_TEMPORARY).catch(() => undefined);
    termination.release();
  }
  // Awaited so a CLI that exits right after still has the log; a logging failure is ignored.
  await Promise.resolve()
    .then(() => options.onActivity?.(sessionActivity(result.stdout)))
    .catch(() => undefined);
  if (result.exitCode !== 0)
    throw new Error(
      `codex exec exited ${result.exitCode ?? "without a status"}: ${(result.error ?? result.stderr).slice(-1200)}${process.platform === "win32" && result.error ? " Check the npm codex.cmd shim and PATH." : ""}`,
    );
  return JSON.parse(await readFile(responsePath, "utf8"));
}

/**
 * A background reviewer or tester process has no abort handler of its own, so an external
 * SIGTERM/SIGINT would leave Codex running. This aborts the run on either signal and, once
 * the runs have had time to clean up, delivers the signal again so the process still ends
 * as it would have. When something else already handles the signal, that handler decides.
 * Listeners of other concurrent runs are ours, not a sign that someone else handles it.
 */
function forwardTermination(signal?: AbortSignal): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  let received: TerminationSignal | undefined;
  const handled = new Set<TerminationSignal>();
  const attached = new Set<TerminationSignal>();
  const listeners = TERMINATION_SIGNALS.map((name) => {
    if (process.listenerCount(name) > ownListeners[name]) handled.add(name);
    const listener = () => {
      received ??= name;
      // A `once` listener is gone after it fires.
      if (attached.delete(name)) ownListeners[name] -= 1;
      controller.abort();
    };
    process.once(name, listener);
    attached.add(name);
    ownListeners[name] += 1;
    return [name, listener] as const;
  });
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    release() {
      for (const [name, listener] of listeners) {
        process.removeListener(name, listener);
        if (attached.delete(name)) ownListeners[name] -= 1;
      }
      if (received && !handled.has(received)) reraiseLater(received);
    },
  };
}

type TerminationSignal = "SIGTERM" | "SIGINT";
const TERMINATION_SIGNALS: readonly TerminationSignal[] = ["SIGTERM", "SIGINT"];
/** Listeners forwardTermination has attached for runs that are still active. */
const ownListeners: Record<TerminationSignal, number> = { SIGTERM: 0, SIGINT: 0 };
const pendingReraise = new Set<TerminationSignal>();

/** Delayed so concurrent runs and their callers' `finally` blocks finish first; once per signal. */
function reraiseLater(name: TerminationSignal): void {
  if (pendingReraise.has(name)) return;
  pendingReraise.add(name);
  setTimeout(() => {
    pendingReraise.delete(name);
    process.kill(process.pid, name);
  }, RERAISE_DELAY_MS).unref();
}

const RERAISE_DELAY_MS = 1000;

/**
 * Codex without network retries for over a minute before failing, after the call is
 * reserved. Sandboxed shells deny sockets, so name resolution fails fast there.
 */
export async function reachesModel(lookup: (host: string) => Promise<unknown>): Promise<boolean> {
  const attempts = ["chatgpt.com", "api.openai.com"].map((host) =>
    Promise.race([
      lookup(host).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000).unref()),
    ]).catch(() => false),
  );
  return (await Promise.all(attempts)).some(Boolean);
}

function reviewerPrompt(packet: unknown, webSearch: boolean): string {
  return [
    "You are an independent reviewer. You did not write this code. Follow `instructions` and answer `question` in the JSON packet below.",
    "Inspect the repository in the current directory read-only where it helps. Do not modify files.",
    ...(webSearch
      ? [
          "You may search the web for public documentation of standards, protocols or libraries the work uses. Never put project code, data, names or secrets in a query; every query is logged for the project's human reviewer.",
        ]
      : []),
    "Respond only with JSON that matches the provided output schema.",
    "",
    JSON.stringify(packet),
  ].join("\n");
}

/**
 * Monitoring for reviewer internet use: one JSON line per review call in the feature's
 * directory, read by `visp pr`. A logging failure never fails the review.
 */
async function recordActivity(
  root: string,
  packet: CriticPacket,
  model: string,
  activity: SessionActivity,
): Promise<void> {
  const feature = (packet.selection as { feature?: unknown } | undefined)?.feature;
  if (typeof feature !== "string" || !/^[A-Za-z0-9._-]+$/.test(feature)) return;
  const task = (packet.selection as { task?: unknown } | undefined)?.task;
  const line = `${JSON.stringify(redactStrings({ at: new Date().toISOString(), model, ...(typeof task === "string" ? { task } : {}), ...activity }, root))}\n`;
  const directory = join(root, ".visp", "features", feature);
  await appendFile(join(directory, REVIEWER_ACTIVITY_FILE), line).catch(() => undefined);
}

export const REVIEWER_ACTIVITY_FILE = "reviewer-activity.jsonl";

/**
 * Inside a host sandbox the operator's Codex home is read-only, and `codex exec` writes to
 * its home even with --ephemeral. The reviewer runs with a private copy of the sign-in in
 * this call's temporary directory, which is removed after the review.
 */
async function privateCodexHome(directory: string): Promise<string> {
  const home = join(directory, "codex-home");
  await mkdir(home, { mode: 0o700 });
  const operatorHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  await copyFile(join(operatorHome, "auth.json"), join(home, "auth.json")).catch(() => undefined);
  return home;
}

/** Images travel as files (`--image`), not base64 inside the prompt. */
async function writeImages(directory: string, packet: CriticPacket) {
  const paths: string[] = [];
  const images = await Promise.all(
    packet.current.images.map(async (image, index) => {
      const entry = image as unknown as Record<string, unknown>;
      if (typeof entry.data !== "string") return image;
      const extension = String(entry.mimeType ?? "image/png").split("/")[1] ?? "png";
      const path = join(directory, `image-${index}.${extension}`);
      await writeFile(path, Buffer.from(entry.data, "base64"));
      paths.push(path);
      const { data: _data, ...rest } = entry;
      return { ...rest, file: path };
    }),
  );
  return { paths, packet: { ...packet, current: { ...packet.current, images } } };
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** What a reviewer or tester session did: web searches and shell commands. */
export interface SessionActivity {
  readonly webSearches: readonly string[];
  readonly commands: readonly string[];
}

function sessionActivity(events: string): SessionActivity {
  const webSearches: string[] = [];
  const commands: string[] = [];
  for (const line of events.split("\n")) {
    let event: { type?: string; item?: { type?: string; query?: unknown; command?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "item.completed" || !event.item) continue;
    if (event.item.type === "web_search" && typeof event.item.query === "string")
      webSearches.push(event.item.query);
    if (event.item.type === "command_execution" && typeof event.item.command === "string")
      commands.push(event.item.command.slice(0, 300));
  }
  return { webSearches, commands };
}

/** Runs Codex in its own process group, so an abort or timeout also ends its descendants. */
async function run(
  executable: string,
  args: string[],
  options: { signal?: AbortSignal; stdin?: string; env?: Record<string, string> },
): Promise<RunResult> {
  const result = await execRun(executable, args, {
    cwd: process.cwd(),
    timeoutMs: 0,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.stdin === undefined ? {} : { input: options.stdin }),
    ...(options.env ? { env: options.env } : {}),
  });
  if (!result.ok) return { exitCode: null, stdout: "", stderr: "", error: result.error.message };
  const { exitCode, stdout, stderr, aborted } = result.value;
  return aborted
    ? { exitCode: null, stdout, stderr, error: "The operation was aborted" }
    : { exitCode, stdout, stderr };
}

/** The reviewer VISP may launch for this project, or undefined when the host delegates. */
export function configuredCriticLauncher(workspace: {
  config: { critic?: { launch?: string; webSearch?: boolean } };
  paths: { root: string };
}): ProductCriticHost | undefined {
  return workspace.config.critic?.launch === "codex-exec"
    ? codexExecCriticHost({
        root: workspace.paths.root,
        webSearch: workspace.config.critic.webSearch === true,
      })
    : undefined;
}
