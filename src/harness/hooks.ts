import {
  EXIT,
  GUARD_PROTOCOL_VERSION,
  PACKAGE_NAME,
  PRODUCT_NAME,
  STATE_DIR,
} from "../core/constants.js";
import { runtimeIdentity } from "../core/version.js";
import { AUTHORIZATION_CHECK } from "./authorization-check.js";

/**
 * Enforcement surfaces. Each one shells out to `visp guard` rather than
 * reimplementing scope rules, so a refusal is identical wherever it happens and
 * updating the rules updates every surface at once.
 */

/** Identifies a file visp wrote, so install never clobbers a foreign hook. */
export const HOOK_MARKER = "managed by visp";
export const HOOK_TEMPLATE_VERSION = 9;

/**
 * Claude Code PreToolUse hook. Receives the tool call on stdin and blocks a
 * write before it happens, which is the only point where an out-of-scope edit
 * can still be prevented rather than merely reported.
 */
export function renderPreToolUseHook(): string {
  return `#!/usr/bin/env node
// ${HOOK_MARKER}; hook-version: ${HOOK_TEMPLATE_VERSION}
// Refuses edits outside the active task's declared scope.
// Decisions come from \`${PRODUCT_NAME} guard\`, so this file holds no rules of its own.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const ALLOW = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };

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
  return process.env.CLAUDE_PROJECT_DIR ?? input?.cwd ?? process.cwd();
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
  } catch {}
  process.exit(0);
}

// A weak worker stopped with slices open and no acceptance, so the pinned tests never ran
// as final checks. Send it back to the next step a few times, only for recent work.
if (input?.hook_event_name === "Stop") {
  const root = projectRoot();
  try {
    const status = JSON.parse(readFileSync(join(root, ".visp", "status.json"), "utf8"));
    const recent = Date.now() - Date.parse(status.updatedAt) < 60 * 60 * 1000;
    if (!status.activeFeature || !recent) process.exit(0);
    const envelope = JSON.parse(
      execFileSync("${PRODUCT_NAME}", ["next", "--feature", status.activeFeature, "--json"], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 170000,
      }).toString(),
    );
    const next = envelope?.data;
    if (!envelope?.ok || !next?.action || next.action === "complete") process.exit(0);
    const counts = join(root, ".visp", "session", "stop-blocks.json");
    let blocked = {};
    try {
      blocked = JSON.parse(readFileSync(counts, "utf8"));
    } catch {}
    // Once reviews are spent the loop ends in a handoff: one reminder to write it.
    const handoff = next.completion === "handoff";
    const key = handoff ? \`\${status.activeFeature}:handoff\` : status.activeFeature;
    const used = blocked[key] ?? 0;
    if (used >= (handoff ? 1 : 3)) process.exit(0);
    mkdirSync(join(root, ".visp", "session"), { recursive: true });
    writeFileSync(counts, JSON.stringify({ ...blocked, [key]: used + 1 }));
    const reason = handoff
      ? \`Independent review of \${status.activeFeature} is spent with findings open. Run \${next.command} and summarize the open findings in your final message for the human reviewer.\`
      : \`Feature \${status.activeFeature} is not accepted yet. Next: \${next.objective} Run: \${next.command}. Continue until visp accept succeeds, or state in your final message why it cannot.\`;
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  } catch {}
  process.exit(0);
}

// A worker deleted .visp and the pinned tests with shell commands to get past a scope
// error. Only such commands are refused; every other command gets no decision here, so
// the host's own permission rules still apply.
if (input?.tool_name === "Bash") {
  const command = String(input?.tool_input?.command ?? "");
  const touchesState = /(^|[\\s'"=/])(\\.visp|acceptance)(\\/|[\\s'"]|$)/.test(command);
  const destructive =
    /\\bgit\\s+clean\\b/.test(command) ||
    /\\bgit\\s+stash\\b.*(\\s-u\\b|--include-untracked|\\s-a\\b|--all)/.test(command) ||
    (touchesState && /\\b(rm|mv|git\\s+(checkout|restore|rm|reset))\\b/.test(command));
  if (destructive) {
    process.stdout.write(
      JSON.stringify(
        deny(
          "This command would remove VISP state or the pinned acceptance tests. Keep them; if visp reports a scope problem, restore or scope the files it names instead.",
        ),
      ),
    );
  }
  process.exit(0);
}

const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;

if (!target) {
  process.stdout.write(JSON.stringify(ALLOW));
  process.exit(0);
}

const root = projectRoot();
const path = isAbsolute(target) ? relative(root, target) : target;

// VISP state changes only through visp commands, which validate and record it. A worker
// that hand-edited the brief left it unreadable and abandoned the workflow. Drafts are
// the one place the workflow asks agents to write.
const statePath = path.replaceAll(String.fromCharCode(92), "/");
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
  stdout = execFileSync("${PRODUCT_NAME}", ["guard", "--path", path, "--json"], {
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
  const cause = status === 0 || status === ${EXIT.refused}
    ? \`no guard result on stdout — is \\\`${PRODUCT_NAME}\\\` on PATH the right one?\`
    : \`exit \${status}\`;
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
  process.stdout.write(JSON.stringify(ALLOW));
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
            hooks: [{ type: "command", command: `node "$CLAUDE_PROJECT_DIR/${hookPath}"` }],
          },
        ],
      },
    },
    null,
    2,
  );
}

/** Pre-commit hook: the last checkpoint before out-of-scope work is recorded. */
export function renderPreCommitHook(): string {
  const installedNode = shellLiteral(process.execPath);
  return `#!/bin/sh
# ${HOOK_MARKER}; hook-version: ${HOOK_TEMPLATE_VERSION}
# Refuses a commit whose staged files fall outside the active task's scope.

authorization_dir=".visp/state/implement-allowed"
product_authorization_dir=".visp/state/product-authorizations"
has_authorization=0

# If guard itself cannot answer, distinguish an open task from a marker left by
# an interrupted older closure. A malformed marker or graph stays conservative:
# without enough state to prove it stale, the hook treats it as active.
node_runtime=$(command -v node 2>/dev/null)
if [ -z "$node_runtime" ] && [ -x ${installedNode} ]; then
  node_runtime=${installedNode}
fi
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

if ! command -v ${PRODUCT_NAME} >/dev/null 2>&1; then
  unchecked "${PRODUCT_NAME} is not on PATH"
  exit $?
fi

# --if-authorized: with no task active you are not working under visp, so
# ordinary commits are left alone.
# --include-done: work from a task visp already closed is still in the tree and
# must remain committable, or finishing a task would strand it.
output=$(${PRODUCT_NAME} guard --staged --if-authorized --include-done --json 2>/dev/null)

# The exit code alone cannot be trusted. Another program named \`${PRODUCT_NAME}\` on
# PATH — an older release, say — exits 1 for its own reasons, and 1 is also the
# refusal code. Only a parseable guard envelope proves this check actually ran,
# so that is what the decision reads.
verdict=$(printf '%s' "$output" | node -e '
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
        run: ${PRODUCT_NAME} guard --base \${{ github.event.pull_request.base.sha }} --scope tasks --branch \${{ github.head_ref }}
`;
}

/** Codex runs hooks through a shell from the session directory; resolve the project root. */
export const CODEX_HOOK_SCRIPT = ".visp/hooks/codex-hooks.mjs";
const CODEX_HOOK_COMMAND = `node "$(git rev-parse --show-toplevel)/${CODEX_HOOK_SCRIPT}"`;

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
