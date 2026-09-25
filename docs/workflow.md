# Workflow

A feature is one brief plus the records VISP generates while the agent works through it. The agent authors only the brief; status, executions, reviews and summaries are generated and should not be edited.

## Starting a feature

```sh
visp feature "<goal>" --source-brief "<original request, verbatim>"
```

Under Claude Code (with the installed prompt hook) and Codex, VISP takes the request from the user's recorded prompt; a `--source-brief` is kept only when it quotes that prompt verbatim, for example one request out of a longer message, so a paraphrase cannot replace it. On other hosts pass the complete request. `--risk low|medium|high|critical` records project risk and `--branch` creates a feature branch. The feature is created under `.visp/features/<id>/` with a `brief.yaml` that holds the preserved request and an empty plan. `feature` pins the current critic configuration into the feature; later changes to defaults do not affect it.

## The brief

Read it with `visp brief --template` (editable form, no state change) or `visp brief` (current brief). Update it in one of two ways:

- `visp brief --patch - --reason "<why>"` merges changed fields from stdin. Entries in `outcomes`, `examples`, `decisions`, `checks` and `slices` merge by `id`; entries without an `id` are appended and receive one. Arrays inside an entry (for example `scope.allowed`) replace that field.
- `visp brief --from - --reason "<why>"` replaces the whole brief. Use it to delete entries.

`--check-template command` and `--check-template browser` print an editable check example. Input can also be a project file path instead of `-`. MCP `visp_brief` accepts `patch`, `brief`, `template` and `reason`.

### Fields

| Field | Contents |
| --- | --- |
| `version`, `feature`, `originalRequest` | Owned by VISP; keep them as returned |
| `goal` | One-line summary of the request |
| `outcomes[]` | `id`, `kind` (`functional`, `quality`, `experience`), `statement`, `priority` (`must`, `should`, `could`; default `must`), `provenance` (`user-stated`, `independent`, `agent-proposed`), optional `expectations[]` (`id`, `statement`, optional `viewport`), `source`, `sourceQuote`, `reviewRequired` |
| `examples[]` | Behavior examples: `id`, `title`, `given[]`, `when`, `expected[]`, `outcomes[]` |
| `decisions[]` | `id`, `statement`, `rationale`, `evidence[]`, `implications[]`, `outcomes[]` |
| `uncertainties[]` | Open questions that could change the implementation |
| `checks[]` | Executable checks (below) |
| `slices[]` | Units of work (below) |
| `acceptanceBaseline` | Pinned acceptance material, kept by VISP |
| `design` | Optional `description`, `references[]`, `refinementCycles` (default 2) |

Functional outcomes need executed evidence. Quality and experience outcomes can also rest on review; an experience outcome needs rendered images to be reviewed.

Changing a method or decision needs only `--reason`. Changing protected intent (outcomes, examples or pinned expectations) needs `--intent-change "<reason>" --provenance "<decision source>"`. That records a claim of authorization; it does not authenticate a person. The original request is never rewritten.

### Normalization

Models often use natural field names. Before strict validation VISP rewrites unambiguous alternatives and lists each rewrite in the reply's `normalized` array. Examples:

- `description`/`text` → `statement`; `then`/`expect` → `expected`; `decision` → `statement`, `reason`/`why` → `rationale`
- `outcome`, `verifies` or `covers` → `outcomes`; a string where a list belongs → a one-item list
- outcome kinds such as `behavior`, `performance` or `ux` → `functional`, `quality` or `experience`
- slice IDs like `S1` → `T001`; a scope given as a list → `scope.allowed`; `exclude`/`blocked` → `forbidden`
- a check's top-level `journey` → `command.journey`
- acceptance criteria placed in `acceptanceBaseline` → expectations of the named outcome

Anything ambiguous is still refused with the invalid field paths.

## Slices and scope

```yaml
slices:
  - id: T001
    goal: Retry a failed save from the banner.
    outcomes: [O001]
    dependsOn: []
    scope:
      allowed: [src/save.js, test/save.test.mjs]
      expected: [src/save.js]
      forbidden: []
    checks: [C001]
    approach: Keep the edited text until persistence succeeds.
    taskClass: bugfix   # optional: feature, bugfix, refactor, test, docs, chore, config
```

`scope.allowed` is the set of paths the agent may change while the slice is authorized; `expected` names the files the slice should touch; `forbidden` narrows `allowed`. `workflow.blockedPaths` from `visp.yml` are never writable, whatever a slice says. Keep the first slice to one usable behavior, including its result and failure path, before expanding.

Scope is enforced by `visp guard`, which the installed hooks call: the Claude Code edit hook before each write, the Git `pre-commit` hook before each commit, and, if installed with `visp install --hooks ci`, a CI job that checks the pull request diff against the slice scopes in the committed brief of the feature that matches the branch (`visp guard --scope tasks`). Changing scope requires a brief update and a new `visp work`.

## Checks

A check is either a command or a browser journey:

```yaml
checks:
  - id: C001
    command: [node, --test, test/save.test.mjs]   # or a string: "npm test"
    outcomes: [O001]
    files: [src/save.js, test/save.test.mjs]
    verifierFiles: [test/save.test.mjs]
    environment: node                              # node, browser or other
```

- **Commands** run as an argument vector, never through a shell. A string is split into arguments; shell syntax such as `&&`, pipes or `VAR=value` prefixes is refused. Use two checks or a script the project owns.
- **Browser journeys** use `command: {kind: browser-journey, journey: {...}}`. VISP drives an installed Chrome/Chromium with an isolated profile and records operations, measurements and screenshots. See [product review](product-review.md).
- **`files`** lists the product and test files the check depends on; changes to them make earlier results stale.
- **`verifierFiles`** lists the assertion program and its helpers, fixtures and configuration. VISP hashes them separately from the product so a repair can be compared against the same verifier. An explicit Node script, preload or `--env-file` argument must be listed, or the check stops before running with an environment failure. Use repository-relative paths.

A check must exercise behavior to count as functional evidence. Syntax-only or static commands (for example `node --check`) still run but do not establish behavior. A check may not run a VISP workflow command (`visp done`, `visp capture` and similar) against its own workspace.

`workflow.validationCommands` from `visp.yml` run alongside every slice's checks as `CONFIG_1`, `CONFIG_2`, and so on. `workflow.acceptanceChecks` are pinned when a feature is created and run at acceptance.

Supervised checks run with a filtered environment and Python bytecode redirected away from the project, so a check does not change the product it checks. A command that could not start (for example, the executable is not installed) is recorded as an environment failure with the note that no product behavior was tested, not as a test failure.

## Work, done, next, accept

**`visp work [--task <id>]`** selects the next ready slice (or the named one), checks that it has an outcome, a bounded scope and runnable checks, and authorizes edits in its scope. It returns the objective, scope, relevant outcomes and findings, source excerpts, graph neighbors, memory notes and admitted skills, trimmed to `context.tokenBudget`. `--inspect` reads the same context without authorizing, probing the environment or refreshing the graph. For slices with browser checks, `work` first confirms an isolated browser can start and capture; `--retry-environment` retries after the host environment is fixed.

**Independent acceptance tests.** With `critic.launch: codex-exec`, `visp feature` starts an independent tester on a new project that writes tests from the original request. VISP keeps them only if they fail before implementation and pins them whenever the tester finishes; `work` does not wait and reports them as `independentTests`. See [the critic guide](critic.md#independent-acceptance-tests).

**Light path.** `visp work --check "<test command>"` on a feature without slices creates one slice covering the whole request (scope `**`, the command as its check) and authorizes it; on a slice without checks it declares that check. Use a full brief only for several independently usable parts.

**The check gate.** `work` refuses a slice whose functional outcome is not exercised by any declared check, and returns a patch that adds one:

```
T001 has no runnable check. Declare the command that exercises this slice
(your test runner or a browser journey) before editing.
```

Without a check, `done` has nothing to execute and the reviewer has no evidence.

**`visp verify`** runs the slice's checks without closing it.

**`visp done`** runs the checks and records each execution. When all pass and any required review is current, the slice closes. If `critic.launch: codex-exec` is set and every check passed, `done` then starts the independent reviewer and waits for it (up to 120 seconds, 50 over MCP), so its findings usually arrive in the same step; see [the critic guide](critic.md). On the last open slice `done` also runs the pinned acceptance tests; on earlier slices it reports them without blocking. While a review is pending, editing, closing and acceptance wait for it.

**`visp next`** is read-only and returns one action with its command. When a background review is running it waits up to 120 seconds (50 seconds over MCP); if the review is still running it returns `action: wait` with `visp next --feature <id>` to run again. `visp status` shows outcomes, slice progress, evidence and open findings.

**Host hooks.** For Claude Code, `visp install` wires hooks into `.claude/settings.json` that refuse out-of-scope edits, record user prompts for `visp feature`, refuse agent edits under `.visp/` (except drafts) and shell commands that would delete VISP state or pinned tests, and on Stop send the worker back to an unfinished, recently active feature (at most three times, once for a handoff). For Codex, it writes the same prompt, shell and Stop hooks to `.codex/hooks.json`; Codex runs project hooks only after you trust them once with `/hooks`. Codex edits through `apply_patch`, so edit scope there is enforced by the Git hook and `visp done`.

**`visp accept`** reruns the checks against the assembled product, including pinned acceptance checks (which `done` also runs on the last open slice), and requires a current assessment of every mandatory outcome and expectation. Passing commands alone do not satisfy it.

Environment failures (a missing browser, or a sandbox that denies sockets to a check) are recorded as `environment-failed`, not as product failures. Fix the environment, or rerun the same command with the host's sandbox escalation, then use `--retry-environment` on `work`, `verify`, `done` or `accept`. Do not change the product to work around them.

After a failure, `work` includes the failing output and says whether it describes the current version. Repeated identical failures ask for a different hypothesis.

## Repairing a finding

1. Run the declared check that shows the defect.
2. `visp reproduce --finding <id> --execution <execution-id> --reason "<how it reproduces>"` links the failed execution to the finding before editing.
3. Repair, rerun the same check and one adjacent behavior.
4. The reviewer resolves the finding with fresh evidence. A passing rerun alone does not resolve it.

## Evidence rules

- An execution record proves that VISP ran a command or journey and what it returned. Whether the assertions test the right thing is still a review judgment.
- Evidence is bound to the current source, brief contract and environment. Changing any of them makes affected evidence stale.
- A failed journey stays unresolved until the same journey passes on the repaired product; a different successful journey does not clear it.
- Review judgments are attributed to their reviewer. The actor's statements, printed summaries and self-reported results are not evidence.
- Missing, stale or unavailable evidence keeps an outcome open; it never becomes a pass.

## `visp pr`

`visp pr` prints a Markdown document built from recorded state:

- the verbatim request;
- an outcomes table with checks and statuses;
- decisions, slice scope and uncommitted changes;
- each check's command and latest executed result, including pinned acceptance checks;
- the independent tests with the request text each relies on, and every intent change;
- independent review attribution, with open findings and their next checks;
- the reviewer's web searches and the tester's commands with network access, when there are any;
- the next step.

`visp handoff` shows the current status in the same form as `status`. Neither command publishes anything.
