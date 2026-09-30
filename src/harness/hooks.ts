import {
  EXIT,
  GUARD_PROTOCOL_VERSION,
  PACKAGE_NAME,
  PRODUCT_NAME,
  STATE_DIR,
} from "../core/constants.js";
import { runtimeIdentity } from "../core/version.js";
import { HOST_SESSION_FILE } from "../workflow/product/host-prompts.js";
import { AUTHORIZATION_CHECK } from "./authorization-check.js";
import { hookCommand } from "./claude-settings.js";

/**
 * Enforcement surfaces. Each one shells out to `visp guard` rather than
 * reimplementing scope rules, so a refusal is identical wherever it happens and
 * updating the rules updates every surface at once.
 */

/** Identifies a file visp wrote, so install never clobbers a foreign hook. */
export const HOOK_MARKER = "managed by visp";
export const HOOK_TEMPLATE_VERSION = 16;

/**
 * Claude Code PreToolUse hook. Receives the tool call on stdin and blocks a
 * write before it happens, which is the only point where an out-of-scope edit
 * can still be prevented rather than merely reported.
 */
export function renderPreToolUseHook(): string {
  const cli = JSON.stringify(runtimeIdentity().executable);
  return `#!/usr/bin/env node
// ${HOOK_MARKER}; hook-version: ${HOOK_TEMPLATE_VERSION}
// Refuses edits outside the active task's declared scope.
// Decisions come from \`${PRODUCT_NAME} guard\`, so this file holds no rules of its own.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const cli = ${cli};

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return undefined;
  }
}

const input = readInput();

// Claude Code names the project in its environment; Codex passes the session cwd instead.
function projectRoot() {
  const start = resolve(process.env.CLAUDE_PROJECT_DIR ?? input?.cwd ?? process.cwd());
  let directory = start;
  while (true) {
    if (existsSync(join(directory, ".visp", "project.json"))) return directory;
    if (existsSync(join(directory, ".git"))) return start;
    const parent = dirname(directory);
    if (parent === directory) return start;
    directory = parent;
  }
}

// The user's own words are the contract the tester and reviewer judge against; workers
// paraphrase them. Kept locally in the git-ignored session directory for \`${PRODUCT_NAME} feature\`.
if (input?.hook_event_name === "UserPromptSubmit") {
  try {
    const directory = join(projectRoot(), ".visp", "session");
    const file = join(directory, "user-prompts.jsonl");
    mkdirSync(directory, { recursive: true });
    let lines = [];
    try {
      lines = readFileSync(file, "utf8").split("\\n").filter(Boolean);
    } catch {}
    lines.push(JSON.stringify({ at: new Date().toISOString(), prompt: String(input.prompt ?? "") }));
    writeFileSync(file, \`\${lines.slice(-20).join("\\n")}\\n\`);
    recordSession();
  } catch {}
  process.exit(0);
}

// A weak worker stopped with slices open and no acceptance, so the pinned tests never ran
// as final checks. Send it back to the next step, only for recent work. A block is a nudge
// about one step: the same step is raised at most twice, and again only when the feature
// changed since the last nudge; a handoff or an unusable environment is raised once.
if (input?.hook_event_name === "Stop") {
  const root = projectRoot();
  try {
    const status = JSON.parse(readFileSync(join(root, ".visp", "status.json"), "utf8"));
    if (!status.activeFeature) process.exit(0);
    // Recent work moves the feature's state file; status.json alone misses a long check.
    let touched = Date.parse(status.updatedAt);
    try {
      touched = Math.max(
        Number.isFinite(touched) ? touched : 0,
        statSync(join(root, ".visp", "features", String(status.activeFeature), "product-state.json")).mtimeMs,
      );
    } catch {}
    if (!(Date.now() - touched < 60 * 60 * 1000)) process.exit(0);
    const envelope = JSON.parse(
      // Unselected, so a later session's untaken request is sent to a feature of its own.
      // The observer marker makes \`${PRODUCT_NAME} next\` trust the worker's recorded browser
      // capability and report a \`progress\` token; it changes nothing else.
      execFileSync(process.execPath, [cli, "next", "--json"], {
        cwd: root,
        env: { ...process.env, VISP_OBSERVER: "stop-hook" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 170000,
      }).toString(),
    );
    const next = envelope?.data;
    if (!next?.feature && typeof input.session_id === "string") {
      const edits = join(root, ".visp", "session", "edits", encodeURIComponent(input.session_id) + ".json");
      try { readFileSync(edits); } catch { process.exit(0); }
    }
    if (!envelope?.ok || !next?.action || next.action === "complete") process.exit(0);
    const day = 24 * 60 * 60 * 1000;
    const plain = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
    const now = Date.now();
    const kind =
      next.completion === "handoff" ? "handoff" : next.completion === "unresolved-environment" ? "environment" : "work";
    const limit = kind === "work" ? 2 : 1;
    // Ids and values change from call to call; the command's verb and flags name the step.
    const words = String(next.command ?? "").split(/\\s+/).filter(Boolean);
    const shape = words.filter((word, index) => index < 2 || word.startsWith("-"));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([status.activeFeature, next.action, next.completion ?? "", next.task ?? "", shape]))
      .digest("hex");
    const progress = typeof next.progress === "string" ? next.progress : "";
    const counts = join(root, ".visp", "session", "stop-blocks.json");
    let entries = {};
    try {
      const stored = JSON.parse(readFileSync(counts, "utf8"));
      if (stored?.version === 2 && plain(stored.entries)) entries = stored.entries;
    } catch {}
    for (const [name, entry] of Object.entries(entries)) {
      if (!plain(entry) || !(now - Date.parse(entry.at) < day)) delete entries[name];
      else if (plain(entry.fps))
        for (const [id, seen] of Object.entries(entry.fps))
          if (!plain(seen) || !(now - Date.parse(seen.at) < day)) delete entry.fps[id];
    }
    const key = [input.session_id ?? "unknown", status.activeFeature].join(":");
    const entry = plain(entries[key]) && plain(entries[key].fps) ? entries[key] : { total: 0, fps: {} };
    const seen = plain(entry.fps[fingerprint]) ? entry.fps[fingerprint] : undefined;
    if ((Number(entry.total) || 0) >= 6) process.exit(0);
    // The same step blocks up to its limit whatever the worker did in between: in weak-worker
    // runs most repeated nudges were followed, and waiting for a progress change let a worker
    // that did nothing stop after one nudge.
    if (seen && (Number(seen.count) || 0) >= limit) process.exit(0);
    // The counter is on disk before the block is emitted; if it cannot be written the
    // worker is not blocked, since nothing would bound the repeats.
    const at = new Date(now).toISOString();
    entries[key] = {
      total: (Number(entry.total) || 0) + 1,
      at,
      fps: { ...entry.fps, [fingerprint]: { count: (Number(seen?.count) || 0) + 1, progress, at } },
    };
    const temporary = counts + "." + process.pid + ".tmp";
    try {
      mkdirSync(join(root, ".visp", "session"), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 2, entries }));
      renameSync(temporary, counts);
    } catch {
      try { unlinkSync(temporary); } catch {}
      process.exit(0);
    }
    const objective = String(next.objective ?? "").trim().replace(/[.\\s]+$/, "");
    const feature = status.activeFeature;
    const command = next.command;
    const reason = !next.feature
      ? command ? \`\${objective}. Run: \${command}\` : \`\${objective}.\`
      : kind === "handoff"
      ? command
        ? \`\${objective}. Run: \${command} once, then say in your final message what is still open and that \${feature} needs the human reviewer.\`
        : \`\${objective}. Say in your final message what is still open and that \${feature} needs the human reviewer.\`
      : kind === "environment"
      ? \`VISP cannot verify \${feature} until its execution environment works: \${objective}.\${command ? \` Run: \${command} once.\` : ""} If it is still unavailable, say in your final message which capability is missing and that \${feature} is not verified; do not retry it repeatedly.\`
      : \`VISP's next step for \${feature}: \${objective}.\${command ? \` Run: \${command}.\` : ""} If your own \\\`${PRODUCT_NAME} next\\\` shows a different step, follow that one. If you cannot finish, say in your final message what is left and why.\`;
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  } catch {}
  process.exit(0);
}

// A worker deleted .visp and the pinned tests with shell commands to get past a scope
// error. Only such commands are refused; every other command gets no decision here, so
// the host's own permission rules still apply.
// \`${PRODUCT_NAME} work\` stamps its authorization with the session that runs it: record the
// session of each shell command just before it runs, as prompts do.
function recordSession() {
  if (typeof input?.session_id !== "string" || !input.session_id) return;
  try {
    const directory = join(projectRoot(), ".visp", "session");
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(directory, "hosts"), { recursive: true });
    writeFileSync(join(directory, "hosts", encodeURIComponent(input.session_id) + ".json"),
      JSON.stringify({ session: input.session_id, at: new Date().toISOString() }));
    writeFileSync(
      join(directory, "${HOST_SESSION_FILE}"),
      JSON.stringify({ session: input.session_id, at: new Date().toISOString() }),
    );
  } catch {}
}

if (input?.tool_name === "Bash") {
  recordSession();
  const command = String(input?.tool_input?.command ?? "");
  const destructive = destructiveShellReason(command);
  if (destructive) {
    process.stdout.write(
      JSON.stringify(
        deny(destructive),
      ),
    );
    process.exit(0);
  }
  const lost = discardedChanges(command);
  if (lost.length > 0) {
    process.stdout.write(
      JSON.stringify(
        deny(
          "This command would discard uncommitted changes to " +
            lost.slice(0, 5).join(", ") +
            (lost.length > 5 ? " and " + (lost.length - 5) + " more" : "") +
            ". They may be earlier work: commit them instead (git add -A && git commit -m '<what they are>'); if the commit fails because Git is read-only, leave them uncommitted. To undo an edit of your own, edit the file back.",
        ),
      ),
    );
  }
  process.exit(0);
}

// A worker discarded a previous session's uncommitted work with git checkout to get the
// clean tree a new feature needs. Commands that would discard uncommitted changes are
// refused: checkout or restore of changed files, forced checkouts and switches, and hard
// resets (untracked files included, which a reset to another commit can overwrite).
// Branch switches that keep changes, staged-only restores and stashes are left alone.
function shellCommands(command) {
  const commands = [[]];
  let word = "";
  let inWord = false;
  let quote = "";
  const end = () => {
    if (inWord) commands[commands.length - 1].push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === "\\n" || c === ";" || c === "&" || c === "|") {
      end();
      commands.push([]);
    } else if (/\\s/.test(c)) {
      end();
    } else {
      word += c;
      inWord = true;
    }
  }
  end();
  return commands.filter((words) => words.length > 0);
}

function destructiveShellReason(command) {
  const protectedOperand = (word) => /^(?:\\.\\/)?(?:\\.visp|acceptance)(?:\\/|$)/.test(word);
  for (const words of shellCommands(command)) {
    const executable = words[0];
    const operands = words.slice(1).filter((word) => !word.startsWith("-"));
    if (executable === "git" && words[1] === "clean")
      return "git clean may delete untracked VISP state or acceptance tests; inspect and remove individual files instead.";
    if (executable === "git" && words[1] === "stash" && words.slice(2).some((word) => /^(?:-[A-Za-z]*[ua]|--include-untracked|--all)$/.test(word)))
      return "git stash of untracked files may hide VISP state or acceptance tests; commit the work instead.";
    const gitDestructive = executable === "git" && ["checkout", "restore", "rm", "reset"].includes(words[1]);
    const fileDestructive = ["rm", "mv"].includes(executable);
    const findDelete = executable === "find" && words.includes("-delete");
    if ((gitDestructive || fileDestructive || findDelete) && operands.some(protectedOperand))
      return "This command would remove VISP state or the pinned acceptance tests. Keep them; if visp reports a scope problem, restore or scope the files it names instead.";
  }
  return undefined;
}

function workingTreeChanges() {
  const entries = execFileSync("git", ["status", "--porcelain", "-z"], {
    cwd: projectRoot(),
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .split("\\0");
  const tracked = [];
  const untracked = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    (code === "??" ? untracked : tracked).push(entry.slice(3));
    if (code[0] === "R" || code[0] === "C") i++;
  }
  return { tracked, untracked };
}

function discardedChanges(command) {
  const targets = [];
  let forced = false;
  let hard = false;
  for (const words of shellCommands(command)) {
    const git = words.indexOf("git");
    if (git < 0) continue;
    const [sub, ...rest] = words.slice(git + 1);
    const separator = rest.indexOf("--");
    const operands = (separator >= 0 ? rest.slice(separator + 1) : rest).filter(
      (word) => separator >= 0 || !word.startsWith("-"),
    );
    const flags = (separator >= 0 ? rest.slice(0, separator) : rest).filter((word) => word.startsWith("-"));
    if (sub === "reset" && flags.includes("--hard")) hard = true;
    else if (sub === "checkout" && flags.some((flag) => flag === "--force" || /^-[A-Za-z]*f/.test(flag)))
      forced = true;
    else if (sub === "switch" && flags.some((flag) => ["-f", "--force", "--discard-changes"].includes(flag)))
      forced = true;
    else if (sub === "checkout" && !flags.some((flag) => ["-b", "-B", "--orphan"].includes(flag)))
      targets.push(...operands);
    else if (
      sub === "restore" &&
      !(flags.includes("--staged") && !flags.includes("--worktree") && !flags.includes("-W"))
    )
      targets.push(...operands);
  }
  if (!hard && !forced && targets.length === 0) return [];
  let changes;
  try {
    changes = workingTreeChanges();
  } catch {
    return [];
  }
  if (hard) return [...changes.tracked, ...changes.untracked];
  if (forced) return changes.tracked;
  const prefixes = targets.map((target) => target.replace(/^\\.\\//, "").replace(/\\/$/, ""));
  return changes.tracked.filter((path) =>
    prefixes.some((prefix) => prefix === "." || path === prefix || path.startsWith(prefix + "/")),
  );
}

const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;

if (!target) {
  process.exit(0);
}

const root = projectRoot();
function realPath(path, depth = 0) {
  if (depth > 40) throw new Error("Too many symlinks in " + path);
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      if (lstatSync(path).isSymbolicLink())
        return realPath(resolve(dirname(path), readlinkSync(path)), depth + 1);
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(realPath(parent, depth + 1), path.slice(parent.length + 1));
  }
}

function outside(path) {
  return path === ".." || path.startsWith(".." + sep) || isAbsolute(path);
}

const absoluteTarget = isAbsolute(target) ? target : resolve(input?.cwd ?? root, target);
const logical = relative(root, absoluteTarget);
const physical = relative(realPath(root), realPath(absoluteTarget));
if (isAbsolute(target) && outside(logical) && outside(physical)) process.exit(0);
if (!outside(logical) && outside(physical)) {
  process.stdout.write(JSON.stringify(deny(String(target) + " resolves outside the project root")));
  process.exit(0);
}
const path = isAbsolute(target) ? (outside(logical) ? physical : logical) : target;
const paths = physical !== path && !outside(physical) ? [path, physical] : [path];

// VISP state changes only through visp commands, which validate and record it. A worker
// that hand-edited the brief left it unreadable and abandoned the workflow. Drafts are
// the one place the workflow asks agents to write.
const statePath = path.replaceAll(String.fromCharCode(92), "/").toLowerCase();
if (
  (statePath === "${STATE_DIR}" || statePath.startsWith("${STATE_DIR}/")) &&
  !statePath.startsWith("${STATE_DIR}/drafts/") &&
  !statePath.split("/").includes("..")
) {
  process.stdout.write(
    JSON.stringify(
      deny(
        \`\${path} is VISP state; change it only through \\\`${PRODUCT_NAME}\\\` commands. For the brief, pipe changed fields: \\\`${PRODUCT_NAME} brief --patch - --reason "<why>"\\\`.\`,
      ),
    ),
  );
  process.exit(0);
}

/**
 * The guard envelope, or undefined when this output did not come from guard.
 *
 * The exit status alone cannot answer that. An argument parser answers
 * ${EXIT.refused} for an unknown option, so a *different* \`${PRODUCT_NAME}\` on
 * PATH — an older release, a similarly named tool — would make every write look
 * like a scope violation, and the agent would be sent to widen allowedFiles to
 * fix what is actually an install problem. A status of 0 from such a binary is
 * worse still: it would allow the write with nothing having been checked.
 *
 * So the envelope is the evidence, not the status. No envelope, no answer.
 */
function guardEnvelope(stdout) {
  try {
    const parsed = JSON.parse(stdout?.toString() ?? "");
    const data = parsed?.data;
    const valid =
      parsed?.command === "guard" &&
      typeof parsed.ok === "boolean" &&
      data?.protocolVersion === ${GUARD_PROTOCOL_VERSION} &&
      data.runtime?.buildId === ${JSON.stringify(runtimeIdentity().buildId)} &&
      data.runtime?.version === ${JSON.stringify(runtimeIdentity().version).replaceAll("'", "\\u0027")} &&
      Number.isInteger(data.checked) &&
      data.checked >= 0 &&
      typeof data.allowed === "boolean" &&
      Array.isArray(data.violations) &&
      Array.isArray(data.authorizedTasks) &&
      data.authorizedTasks.every((task) => typeof task === "string") &&
      (parsed.ok
        ? data.allowed === true && data.violations.length === 0
        : data.allowed === false &&
          data.violations.length > 0 &&
          data.violations.every((finding) => typeof finding?.message === "string"));
    return valid ? parsed : undefined;
  } catch {
    return undefined;
  }
}

let status = 0;
let stdout;
try {
  const asking =
    typeof input?.session_id === "string" && input.session_id ? ["--session", input.session_id] : [];
  stdout = execFileSync(process.execPath, [cli, "guard", "--path", ...paths, "--json", ...asking], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  status = typeof error?.status === "number" ? error.status : undefined;
  stdout = error?.stdout;
  if (error?.code) status = String(error.code);
}

const envelope = guardEnvelope(stdout);

if (envelope === undefined) {
  let authorization = "unknown";
  try {
    authorization = execFileSync(process.execPath, ["-e", ${JSON.stringify(AUTHORIZATION_CHECK)}], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {}
  // No task is active, so there is nothing to enforce: leave Claude's own permission decision in place.
  if (authorization === "inactive") process.exit(0);
  let guardError;
  try { guardError = JSON.parse(stdout?.toString() ?? "").error?.message; } catch {}
  const cause = guardError || (status === 0 || status === ${EXIT.refused}
    ? \`no guard result on stdout — is the installed VISP CLI intact?\`
    : \`exit \${status}\`);
  process.stdout.write(
    JSON.stringify(
      deny(
        \`${PRODUCT_NAME} could not check \${path} (\${cause}), so the write was refused rather than allowed unchecked. Run \\\`${PRODUCT_NAME} doctor\\\` to find out why.\`,
      ),
    ),
  );
  process.exit(0);
}

if (status === 0 && envelope.ok) {
  if (typeof input?.session_id === "string") {
    try {
      const directory = join(root, ".visp", "session", "edits");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, encodeURIComponent(input.session_id) + ".json"), JSON.stringify({ at: new Date().toISOString() }));
    } catch {}
  }
  process.exit(0);
}

let reason = \`\${path} is outside the scope authorized for the current task.\`;
const first = envelope?.data?.violations?.[0];
if (first?.message) {
  // Closing a task clears its authorization, so the window right after
  // \`${PRODUCT_NAME} done\` has none at all. Name the way forward rather than
  // leaving the agent with a refusal it cannot act on.
  if (first.reason === "no-authorization") {
    reason = \`\${first.message}. No task is authorized right now — run \\\`${PRODUCT_NAME} next\\\` to see what is next, then \\\`${PRODUCT_NAME} work --task <id>\\\`.\`;
  } else if (first.reason === "outside-allowed-files") {
    reason = \`\${first.message}. Authorize the task that owns this file, or widen its allowedFiles — do not work around the refusal.\`;
  } else if (first.reason === "transaction-pending") {
    reason = first.message;
  } else {
    reason = \`\${first.message}. This path cannot be written by any task.\`;
  }
}
process.stdout.write(JSON.stringify(deny(reason)));
`;
}

/** The settings block a user merges into `.claude/settings.json`. */
export function renderClaudeSettingsSnippet(hookPath: string): string {
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write|NotebookEdit",
            hooks: [{ type: "command", command: hookCommand(hookPath, true) }],
          },
        ],
      },
    },
    null,
    2,
  );
}

/** Pre-commit hook: the last checkpoint before out-of-scope work is recorded. */
export function renderPreCommitHook(chained = false): string {
  const installedCli = shellLiteral(runtimeIdentity().executable);
  return `#!/bin/sh
# ${HOOK_MARKER}; hook-version: ${HOOK_TEMPLATE_VERSION}
# Refuses a commit whose staged files fall outside the active task's scope.
${chained ? '\n# Preserve the project hook that preceded VISP.\nif [ -x "$0.local" ]; then "$0.local" "$@" || exit $?; fi\n' : ""}

authorization_dir=".visp/state/implement-allowed"
product_authorization_dir=".visp/state/product-authorizations"
has_authorization=0

# If guard itself cannot answer, distinguish an open task from a marker left by
# an interrupted older closure. A malformed marker or graph stays conservative:
# without enough state to prove it stale, the hook treats it as active.
node_runtime=$(command -v node 2>/dev/null)
if [ -n "$node_runtime" ]; then
  authorization_state=$("$node_runtime" - "$authorization_dir" <<'VISP_AUTHORIZATION_CHECK' 2>/dev/null
${AUTHORIZATION_CHECK}
VISP_AUTHORIZATION_CHECK
  )
  case "$authorization_state" in
    active|unknown)
      has_authorization=1
      ;;
  esac
else
  # Node is unavailable too, so no safe semantic read is possible. Preserve
  # fail-closed behavior for any marker that might still be active.
  for marker in "$authorization_dir"/*.json "$product_authorization_dir"/*.json; do
    if [ -f "$marker" ]; then
      has_authorization=1
      break
    fi
  done
fi

unchecked() {
  echo "" >&2
  echo "visp could not check this commit: $1." >&2
  echo "Run '${PRODUCT_NAME} doctor' to find out why." >&2
  if [ "$has_authorization" -eq 1 ]; then
    echo "An active VISP authorization exists, so the commit was refused rather than allowed unchecked." >&2
    return 1
  fi
  echo "No VISP task is authorized, so this ordinary commit is allowed with a warning." >&2
  return 0
}

if [ -z "$node_runtime" ]; then
  unchecked "node is not on PATH"
  exit $?
fi

# --if-authorized: with no task active you are not working under visp, so
# ordinary commits are left alone.
# --include-done: work from a task visp already closed is still in the tree and
# must remain committable, or finishing a task would strand it.
output=$("$node_runtime" ${installedCli} guard --staged --if-authorized --include-done --json 2>/dev/null)

# The exit code alone cannot be trusted. A stale or corrupted CLI might also
# exit 1, the refusal code. Only a parseable guard envelope proves this check ran,
# so that is what the decision reads.
verdict=$(printf '%s' "$output" | "$node_runtime" -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(raw);
    const data = parsed?.data;
    const valid =
      parsed?.command === "guard" &&
      typeof parsed.ok === "boolean" &&
      data?.protocolVersion === ${GUARD_PROTOCOL_VERSION} &&
      data.runtime?.buildId === ${JSON.stringify(runtimeIdentity().buildId)} &&
      data.runtime?.version === ${JSON.stringify(runtimeIdentity().version).replaceAll("'", "\\u0027")} &&
      Number.isInteger(data.checked) &&
      data.checked >= 0 &&
      typeof data.allowed === "boolean" &&
      Array.isArray(data.violations) &&
      Array.isArray(data.authorizedTasks) &&
      data.authorizedTasks.every((task) => typeof task === "string") &&
      (parsed.ok
        ? data.allowed === true && data.violations.length === 0
        : data.allowed === false &&
          data.violations.length > 0 &&
          data.violations.every((finding) => typeof finding?.message === "string"));
    if (!valid) { console.log("unchecked"); return; }
    if (parsed.ok) { console.log("allow"); return; }
    const first = parsed.data?.violations?.[0];
    console.log("refuse " + (first?.message ?? "changes are outside the authorized scope"));
  } catch {
    console.log("unchecked");
  }
});
' 2>/dev/null)

case "$verdict" in
  allow)
    exit 0
    ;;
  refuse*)
    echo ""
    echo "Commit refused: \${verdict#refuse }"
    echo "Adjust the task's allowedFiles, or unstage the extra files."
    exit 1
    ;;
  *)
    unchecked "the guard returned no valid result"
    exit $?
    ;;
esac
`;
}

/** A generated shell hook must not let an interpreter path become shell syntax. */
function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Pull-request check. A fresh checkout has the committed trail — spec, plan,
 * task graph, evidence — but no implement markers, which are per-worktree. So
 * it asks the graph what the feature declared it would touch, rather than what
 * some developer's machine happened to authorize.
 *
 * The version is pinned: an unpinned install lets a new release change the
 * verdict on an unchanged repository, which is the opposite of the claim that
 * the same state produces the same answer.
 */
export function renderCiWorkflow(version: string): string {
  return `name: visp
# ${HOOK_MARKER}

on:
  pull_request:

permissions:
  contents: read

jobs:
  scope-and-evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g ${PACKAGE_NAME}@${version}
      - name: Check the diff against what the feature declared it would touch
        # actions/checkout detaches HEAD for a pull_request, so git cannot name
        # the branch and visp is told it explicitly.
        env:
          HEAD_REF: \${{ github.head_ref }}
        run: ${PRODUCT_NAME} guard --base \${{ github.event.pull_request.base.sha }} --scope tasks --branch "$HEAD_REF"
`;
}

/**
 * Codex runs hooks through a shell from the session directory; resolve the project root.
 * The command keeps its earlier text on purpose: Codex trusts a hook by a hash of its command,
 * so changing it would make upgraded projects skip every hook silently.
 */
export const CODEX_HOOK_SCRIPT = ".visp/hooks/codex-hooks.mjs";
const CODEX_HOOK_COMMAND =
  process.platform === "win32"
    ? `for /f %i in ('git rev-parse --show-toplevel') do @node "%i\\${CODEX_HOOK_SCRIPT.replaceAll("/", "\\")}" || exit /b 2`
    : `node "$(git rev-parse --show-toplevel)/${CODEX_HOOK_SCRIPT}" || exit 2`;

/**
 * Codex reads `.codex/hooks.json` in Claude Code's format. The same script records user
 * prompts, sends a stopping worker back to unfinished work and refuses shell commands that
 * would delete VISP state. Codex edits files through apply_patch rather than a file-path
 * tool, so edit scope is enforced by the Git hook and `visp done`, not here.
 */
export function renderCodexHooks(): string {
  const entry = (extra: Record<string, unknown> = {}) => ({
    hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, ...extra }],
  });
  return `${JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [entry()],
        Stop: [entry({ timeout: 180 })],
        PreToolUse: [{ matcher: "Bash", ...entry() }],
      },
    },
    null,
    2,
  )}\n`;
}
