# Configuration

## `visp.yml`

`visp init --harness <host>` writes a commented `visp.yml` at the project root. Every key is optional; the values below are the defaults unless noted. Unknown keys are rejected with their path, and the file is never rewritten for you.

```yaml
preset: typescript          # detected at init; react, node-api, typescript, javascript, python, go, rust, generic
harness: claude-code        # claude-code, opencode, codex, copilot, cursor, generic (default generic)
profile: minimal            # minimal or standard

critic:                     # see docs/critic.md
  harness: claude-code
  # launch: codex-exec
  # webSearch: true        # reviewer web search, every query logged (codex-exec only)
  # existingCodeTests: true # experimental: independent tester on existing codebases
  # mode: auto

workflow:
  strictness: standard      # relaxed, standard, strict, locked
  reviewMode: current       # current or observation-preview
  maxChangedFiles: 40
  blockedPaths: [".env", ".env.*", node_modules, dist, build, .git]
  validationCommands: []    # for example: - pnpm test
  acceptanceChecks: []
  flipCheck: auto           # historical telemetry label only

graph:
  languages: [typescript, javascript, python]
  exclude: []
  maxFileBytes: 1048576

context:
  tokenBudget: 12000
  maxSnippets: 4

skills:
  enabled: true
  mode: review              # review is the only supported mode
  minSupport: 3
  maxPerPack: 3

memory:
  enabled: true

telemetry:
  enabled: true
```

| Key | Meaning |
| --- | --- |
| `preset` | Project type detected at init; used to suggest `validationCommands`. Changing it later regenerates nothing. |
| `harness` | The coding host `visp install` targets. Rerun `visp install` after changing it. |
| `profile` | How much always-resident text is installed. `minimal` installs a short guide and the core MCP tools (every other capability stays available as a CLI command); `standard` installs the full guide and all MCP tools. Rerun `visp install` after changing it. |
| `critic` | Reviewer host, launch mode, feedback mode, model and budgets. See [the critic guide](critic.md). |
| `critic.webSearch` | With `launch: codex-exec`, lets the reviewer search the web for public documentation; every query is logged and listed by `visp pr`. |
| `critic.existingCodeTests` | Experimental. With `launch: codex-exec`, also runs the independent tester on existing codebases, in a disposable copy with network access. See [the critic guide](critic.md#independent-acceptance-tests). |
| `workflow.strictness` | Default rule strictness until a policy is recorded; afterwards use `visp policy set-strictness <mode>`. `locked` is `strict` with overrides refused. |
| `workflow.reviewMode` | `observation-preview` is an opt-in review mode; see [product review](product-review.md). |
| `workflow.maxChangedFiles` | Changed-file ceiling for an authorized slice. A recorded policy limit takes precedence. |
| `workflow.blockedPaths` | Paths an agent may never write, regardless of slice scope. They are also left out of the source VISP delivers and of the tester's execution-mode copy. |
| `workflow.validationCommands` | Commands run with every slice's checks as `CONFIG_1`, `CONFIG_2`, … One entry is one command, run without a shell; write `pnpm test` and `pnpm lint` as two entries, or give an argument list such as `["pnpm", "test", "--", "--reporter=dot"]`. |
| `workflow.acceptanceChecks` | `{command, files}` checks pinned into each new feature and run at `visp accept`. |
| `workflow.flipCheck` | Kept for labeling historical telemetry; current verification does not run flip checks. |
| `graph.languages`, `graph.exclude`, `graph.maxFileBytes` | What the repository index parses. |
| `context.tokenBudget` | Approximate budget for the complete context `work` delivers. |
| `context.maxSnippets` | Maximum source excerpts in delivered context. |
| `skills.*` | Skill selection: `minSupport` closed slices a derived proposal must cite; `maxPerPack` admitted skills per context (0 selects none). |
| `memory.enabled` | Deliver matching project notes in `work` context. |
| `telemetry.enabled` | Local attempt and usage records. They never leave the machine. |

`visp doctor --settings` (MCP `visp_doctor` with `settings: true`) shows each effective value, whether it came from the file or a default, and which controls are inactive.

## Policy and overrides

Rules can be inspected and changed without editing `visp.yml`:

```sh
visp policy show
visp policy set-strictness strict
visp policy set <rule> <on|off>
visp override create <rule> --reason "<why>" --days 3
visp override list
visp override revoke <id>
```

Policy and overrides are stored in `.visp/policy.json` and `.visp/overrides.json` and are committed, so an exception is visible to reviewers.

## Repository index

`visp index` reads the repository without running it and uses tree-sitter to extract definitions, imports, calls, and the tests that cover them, for TypeScript, JavaScript and Python. HTML pages contribute their script chain, so `index.html → main.js` is an edge. Entrypoints (for example an Express route) are recognized from code, not from file names. `visp index --refresh` re-indexes only what changed; `visp work` refreshes the graph when source exists.

```sh
visp query describe                    # what is in this repository
visp query search makeToken            # where is it defined
visp query callers src/auth/token.ts   # what would break
visp query testsFor src/auth/token.ts  # what covers it
visp query impact src/auth/token.ts    # what depends on it, transitively
visp query unknowns                    # what the index could not resolve
```

Other operations are `entity`, `neighbors`, `callees` and `tracePath`. `--depth`, `--results`, `--nodes` and `--edges` bound a query (defaults 3, 50, 2,000 and 8,000; maxima 8, 200, 20,000 and 80,000). A truncated answer keeps its unknowns, so a partial result never looks complete. MCP exposes `visp_index` and `visp_query`.

## Memory and skills

`visp learn "<note>"` records a project note under `.visp/memory/`; `visp recall [query]` lists notes. `work` delivers up to four matching notes (6,000 bytes) labeled with their source; notes are untrusted context, not instructions.

Skills are procedures a person admits into the project. They are advice selected by a trigger; they cannot widen scope, change policy or satisfy a check.

```sh
visp skill catalog                     # bundled skills
visp skill seed <id>                   # copy one in as an inert proposal
visp skill propose --id <id> --file SKILL.md --feature <feature> --from-task T001 T002 T003
visp skill admit <id> --by <reviewer>
visp skill list
visp skill retire <id> --reason "<why>"
```

See [internals](internals.md#skills) for revision, evaluation and rollback records.

## The `.visp/` directory

`init` adds the machine-local parts to `.gitignore`; everything else under `.visp/` is meant to be committed, because a reviewer or CI needs to see what a change declared and what was checked.

| Path | Tracked | Contents |
| --- | --- | --- |
| `features/<id>/brief.yaml` | yes | The authored brief |
| `features/<id>/product-state.json` | yes | Generated slice status, executions, reviews and findings |
| `features/<id>/captures/` | yes | Screenshots from browser journeys |
| `features/<id>/review-sessions/` | yes | Prepared review packets and responses |
| `features/<id>/critic/`, `critic-budget.json` | yes | Critic requests, attempts and the feature's call ledger |
| `features/<id>/candidates/` | yes | Saved source candidates |
| `features/<id>/acceptance-tests.json` | yes | The independent tester's record: status, tests with their request quotes, the baseline run |
| `features/<id>/reviewer-activity.jsonl`, `tester-activity.jsonl` | yes | Web searches and commands of VISP-launched reviewer and tester sessions |
| `policy.json`, `overrides.json` | yes | Recorded rules and exceptions |
| `project.json` | yes | Preset and project identity |
| `memory/` | yes | Project notes |
| `skills/` | yes | Skill documents, revisions and lifecycle history |
| `exports/`, `migrations/backups/` | yes | History exports and upgrade backups from `visp-migrate` |
| `hooks/` | yes | Generated hook scripts |
| `state/` | no | Local slice authorizations (`state/product-authorizations/`), install records, transaction journals and the writer lock |
| `graph/` | no | The repository index database |
| `session/` | no | Per-session data, including recent user prompts recorded by the host's prompt hook |
| `cache/`, `prompts/`, `reports/` | no | Derived data |
| `status.json` | no | This checkout's active feature and slice |
| `telemetry.json`, `telemetry.json.events/` | no | Local usage records |

Authorizations are per checkout: authorizing a slice on one machine grants nothing elsewhere, which is why CI judges a pull request against the committed brief instead. Let VISP commands write everything under `.visp/`; do not edit generated records by hand.

Pinned acceptance tests live outside `.visp/`, under `acceptance/<feature>/`, and are committed with the feature.

If an older `.gitignore` ignores all of `.visp/`, `init` leaves it alone and `visp doctor` reports it with the replacement lines.
