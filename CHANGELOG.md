# Changelog

## Unreleased

### Added
- Bundled skill `edge-cases-first` (`visp skill seed edge-cases-first --by <name>`, then `visp skill admit`): pin current behavior and the request's edge cases as tests before changing code. In three-run Haiku comparisons it passed 420 of 435 hidden checks against 416 without it, at 20% more wall time, so it is not seeded by default.
- `bench/setup_arm.py --skill <id>` seeds and admits a bundled skill, so two arms on one build differ only by that skill.

### Fixed
- Admitted skills reach the worker: an over-budget pack now drops graph rows and source excerpts before skills (it dropped skills first, while keeping excerpts the compact reply never shows), and compact `work` replies show each skill's steps as plain text instead of an escaped JSON string.
- The benchmark runners start each worker in its own session: one worker's `kill %1` on its test server ended every run in the batch.

## 0.5.0-beta.1 - 2026-09-26

### Added
- **Independent review launched by VISP.** `critic.launch: codex-exec` (written by `visp init --harness codex`) runs a read-only, ephemeral `codex exec` reviewer once a slice's checks pass and returns its findings as the next repair step; `visp accept` has it assess the assembled product first. Weak workers never ran the host delegation protocol, so their work was never reviewed. `launch: host` keeps host-orchestrated delegation.
- **Independent acceptance tests.** With `codex-exec`, `visp feature` starts a separate tester that writes one standard-library test file from the original request alone. VISP keeps it only if it has assertions and fails on the unimplemented project (after one repair round with the failure output), saves it under `acceptance/<feature>/` and pins it as protected intent (provenance `visp-tester`). `done` on the last open slice and `accept` run it, `done` on earlier slices reports it without blocking, and `work` does not wait for it. It runs for new projects only (fewer than three tracked source files): on existing codebases its suites assumed behavior the code does not have, and workers changed correct code to satisfy them.
- **`critic.existingCodeTests: true`** (experimental, opt-in) runs the tester on existing codebases in execution mode: in a disposable copy with network it runs the existing program, and its tests of existing behavior, using every assertion helper its new tests use, must pass on the real code before anything is pinned. The copy leaves out VISP state, `workflow.blockedPaths` and common secret files, the session's commands get only core environment variables, and every command is logged to `.visp/features/<id>/tester-activity.jsonl` and listed by `visp pr`. In trials 11 of 14 pinned suites were correct against a reference implementation.
- **`critic.webSearch: true`** (written by `visp init --harness codex`) lets the reviewer search the web for public documentation. It is monitored: each call's searches and commands are logged to `.visp/features/<id>/reviewer-activity.jsonl`, `visp pr` lists every query, and the reviewer is told never to put project code or secrets in a query.
- **Request capture.** `visp feature` takes the request from the user's recorded prompt: the Claude Code prompt hook (`.visp/session/user-prompts.jsonl`, git-ignored) or, inside Codex, the session file named by `CODEX_THREAD_ID`. A worker's `--source-brief` is kept only when it quotes a recorded prompt verbatim; without a recorded prompt, `codex-exec` requires the complete request as `--source-brief` (`-` reads stdin). Workers passed 187–238-character summaries of a 2,700-character contract, so tester and reviewer judged against the wrong request.
- **Light path.** `visp work --check "<test command>"` on a feature without slices works the whole request as one slice (scope `**`, the command as its check); on a slice without checks it declares that check. `visp feature` and `visp next` point to it first. Weak workers spent about six minutes planning small changes that bare coding finished in two to three.
- **Host hooks.** Claude Code: a Stop hook sends the worker back to an unfinished, recently active feature (at most three times, once for a handoff); agent edits under `.visp/` are refused except drafts; shell commands that would delete or stash VISP state or pinned tests are refused. Codex: `visp install --harness codex` writes the prompt, shell and Stop hooks to `.codex/hooks.json`, which Codex runs after the user trusts them once with `/hooks`; edit scope stays with the Git hook and `visp done`, because Codex edits through `apply_patch`.
- **`visp pr`** prints a reviewer document built from recorded state: the verbatim request, outcomes with their checks and statuses, decisions, slice scope and uncommitted changes, each check's latest executed result (pinned checks included), the independent tests with the request text each relies on, intent changes, review attribution with open findings, the reviewer's web searches, the tester's networked commands and the next step.
- `visp work` refuses a slice with a functional outcome that no check exercises and shows a one-patch fix: without a runnable check, `done` had nothing to execute and the reviewer no evidence.

### Changed
- The license is now Apache-2.0 (was MIT), which adds an explicit patent grant and states the terms contributions are made under.
- The loop always ends: in acceptance, or, once the review budget is spent with findings open, in a handoff (`visp next` returns `completion: handoff` and routes to `visp pr`).
- Review packets list open findings by ID, and a fresh reviewer may close a functional finding by re-checking it against current passing executions when no failing reproduction was recorded. Findings are required only for departures from the stated request, including a regression of behavior the repository documents. After a clean review, middle slices skip review until the slice that completes the feature.
- The default critic budget is 3 reviews per feature (was 6; `maxCalls` allows up to 6): in weak-worker runs the first three found every contract gap the hidden tests checked. `visp init --harness codex` sets the reviewer's `reasoningEffort: medium`, which matched `high` on hidden tests and cut runs from 14.2 to 12.0 minutes on average.
- `visp done` waits for the review it started (up to 120 seconds on the CLI, 50 over MCP), and `visp next` waits likewise and returns `action: wait` while it runs. Over MCP and on hosts other than Codex the review runs in a detached process that records its own result, because hosts killed a review running inside the worker's turn; from a Codex worker's CLI the reviewer and tester run inside the command, because Codex's sandbox ends background processes.
- Compact output: CLI text for `work`, `done`, `verify`, `accept`, `next`, `feature`, `capture`, `control` and brief updates is compact like MCP text, and `--json` or `detail: true` returns the complete result. Tool definitions shrank from 44k to 21k characters and closed-slice replies from 14k to 1k; repeated resident instructions, approval history and repair context were cut.
- Brief updates normalize common authoring shapes (`description`, `then`, string `given`, list `when`, `decision`/`reason`, slice IDs like `S1`, check objects inside `slices[].checks`, acceptance criteria placed in `acceptanceBaseline`, a reworded `originalRequest`) and report each rewrite in `normalized`; ambiguous input is still refused with its field paths. `--from` also reads drafts in the system temporary directory and suggests stdin for other paths outside the project. Scope errors name the out-of-scope files.

### Fixed
- Windows: every check was recorded as an environment failure ("Unsafe check receipt directory") because the receipt checks compared POSIX permission bits, which Windows does not report; they are compared on POSIX only. Checkouts now use LF line endings (`.gitattributes`), since CRLF broke byte-exact fixtures.
- macOS: the recursion guard for checks now resolves inherited project roots, so a project reached through a symlink (macOS temporary directories sit under `/var`) is still recognized; review-calibration inputs are refused only when the file itself is a symlink, not when a parent directory is.
- The package smoke test passes the verbatim request, matches the Codex template's medium reviewer effort, and puts a failing `codex` stub on PATH so it never launches a model.
- A check whose sockets the host sandbox denied is recorded as an environment failure with the instruction to rerun with sandbox escalation, not as a product failure.
- The Codex reviewer checks that it can reach its model before a call is reserved, and runs with a private writable copy of the Codex sign-in; inside a host sandbox the operator's Codex home is read-only.
- File transactions treat a write of identical bytes as a no-op; critic reservation rewrote every tracked file and failed under Codex's read-only `.agents/`.
- Supervised checks redirect Python bytecode with `PYTHONPYCACHEPREFIX`, so a check no longer changes the product it checks.
- A tester whose process the host ended is reported as failed instead of staying `running`, and the tester's baseline runs end their whole process group, so a suite that starts a server no longer leaves it running.
- Reviewer activity logging no longer raises an unhandled rejection for a packet without a selection, and the log is written before the command exits.
- Brief validation names invalid field paths without repeating schema internals; native critic schemas offer exact outcome IDs and select citations from supplied evidence IDs; a known finding with insufficient repair evidence stays unresolved without discarding the rest of the review; rejected reviews give a nonzero CLI exit and an MCP error result without automatic retry.
- Critic packets summarize obsolete capture notices while keeping current image failures; repair handoffs link findings to cited runner observations and the replay command; the visual checkpoint recognizes current independent outcome assessments; graph entries return to context when oversized excerpts are dropped.

### Removed
- Unused source: the historical observation writer (`recordObservation`, about 550 lines), the unused half of the legacy `ArtifactStore` (attempt, trail, pull-request, project and acceptance readers and writers), `evidence-persistence.ts`, and a dozen functions and constants nothing called. Tests that arrange historical records use equivalents in `tests/unit/support`.
- The stage workflow (`research`, `spec`, `plan`, `tasks`), `context`, `gate` and other commands, tools, library exports and configuration keys replaced by the product loop. See [migration](docs/migration.md) for replacements and `visp-migrate` for upgrading saved history.

## 0.4.0-beta.3 - 2026-09-15

### Fixed
- Browser journeys can change viewport within the same session, preserving the
  running product so rotation and resize regressions can be observed. Pointer
  state and action validation have focused unit and real-browser coverage.
- Revised declared assertions can be diagnosed after the same check passes,
  preserving original input, mandatory outcomes and raw failure history.
- Runner-owned execution summaries avoid repeatedly delivering capture payloads.
  Review images retain intermediate operation context and source freshness.
- UI critic guidance preserves call capacity until rendered evidence is available.
  Explicit source-only advice remains separate from product review; critic
  limitations remain visible to the worker.
- Narrowed generated-input exclusions and improved source-context and image
  handling, with regression fixtures confined to tests.

### Evaluation limitations
- Live pilots have verified working browser input and actual native critic
  invocation, but do not establish better generated products than baseline
  `243121a`. In the latest missile pilot the critic returned no findings and an
  invented evidence reference; its review was rejected. Successful submission
  command handling must not be interpreted as an accepted review.
- This prerelease does not claim to fix critic judgment quality. Continued
  evaluation will measure gameplay, usability, missed defects and administrative
  effort separately. Observation-preview remains opt-in.

## 0.4.0-beta.2 - 2026-09-15

### Changed
- Replaced authored stage documents with a versioned feature brief and a shared
  CLI/MCP product loop: understand, work on a usable slice, observe, and correct.
  Research and graph context answer relevant questions instead of imposing stages.
- Added configurable automatic and manual critic feedback, independent review
  packets, explicit native handoffs, and advisory recovery when a critic cannot run.
  Configured models, call budgets, and deadlines remain explicit; VISP does not
  impose critic character or token ceilings.
- Preserved scope enforcement, transactional state, graph queries, execution
  records, and historical evidence. Removed superseded workflow machinery and
  consolidated shared CLI/MCP behavior.

### Fixed
- Prepared review sessions now derive supporting image links from recorded
  execution. Valid citations no longer require the worker to reconstruct envelope
  fields or duplicate capture bookkeeping. Stale, unselected, failed, or unrelated
  evidence cannot become passing product evidence through these links.
- Browser journeys can be replayed from recorded operations. Feedback distinguishes
  possible behavior regressions, environment gaps, and corrected expectations;
  changing input methods does not erase an unresolved original failure.
- Review image selection balances representative states across viewports within
  the existing image budget. Critic summaries and limitations remain visible.
- Attached critic adapters distinguish cancellation, deadline expiry, and returned
  responses, record observed timing, and prevent duplicate invocation. These
  records do not claim to measure hidden provider startup or billing.
- Improved browser executable/environment identity, capture recovery, check input
  guidance, graph freshness, task resolution, TypeScript configuration parsing,
  observation identities, telemetry handling, and submodule diagnostics.

### Compatibility and limitations
- Legacy features require explicit migration; preview with `visp migrate --dry-run`.
  Historical artifact and evidence bytes are retained. Legacy authoring commands
  return `WORKFLOW_REPLACED`; read-only status does not migrate implicitly.
- Critic transport still depends on host capabilities and authorization. A native
  Codex/Sol review timeout remains under investigation; passing engineering tests
  does not establish that a model will return useful criticism in every host.
- The baseline commit `243121a` remains the comparison reference. Local regression
  coverage establishes workflow behavior and bookkeeping fixes, not a general
  improvement in generated product quality. Repeated model comparisons are still
  required. Game prompts and evaluator expectations live only in test fixtures.

## 0.4.0-beta.1 - 2026-09-04

### Security
- All CLI and MCP enum/artifact identifiers are parsed before workspace paths are
  resolved or state is changed. Managed storage now rejects traversal, portable
  absolute paths, and symlink components beneath the canonical project root.
- Init, harness installation, task closure, and evidence compaction use recoverable
  file transactions. Journals retain bytes and modes so an interrupted mutation can
  be rolled back by the next mutating command or `visp doctor --fix`.
- Generated enforcement is versioned and inspected live. A malformed or unavailable
  guard blocks commits while a VISP authorization exists; ordinary commits with no
  active VISP task remain allowed with a warning. CI remains the authoritative guard.

### Changed
- Harness assets and project-instruction activation are checked separately. Codex and
  OpenCode installs add an idempotent managed reference to `AGENTS.md`; conflicting
  edited blocks are preserved unless `--force` is explicit. Cross-harness cleanup is
  opt-in and removes only fingerprint-matched VISP assets.
- Closing the final task transactionally refreshes `pr.json`, moves the existing stage
  to `pr`, and returns terminal completion. Repeating `done` reconciles interrupted
  closure without rerunning evidence; `done --base` refuses a mixed committed/dirty
  basis that would omit relevant changes.
- Probe receipts remain visible but caller-supplied identities are explicitly
  unverified. They cannot establish independence or gate review. Repeated identical
  failures now escalate from context feedback to changed-hypothesis steering and then
  stop recommending an unchanged retry.
- Observation freshness is based on stable criterion/context/capture content rather
  than timestamps or delivery metadata. Legacy hashes and attachment paths remain
  readable; new attachments are content-addressed per feature.
- Low-risk features may opt into `--workflow compact`, which skips mandatory research
  while retaining specification, planning, task scope, context, authorization,
  verification, review, and closure. Full remains the default. Evidence compaction is
  dry-run by default and quarantines removals when explicitly applied. Explicit
  attempt retention now keeps a validated rollup of counts, time range, and failure
  fingerprints for later status and PR generation.

### Fixed
- The `tested_by` edge was read backwards by both consumers, so `test-of-allowed-file`
  pack entries were modules and the `evidence.test-signal` review check never fired
  when an index existed. Repos with an index will start seeing this finding — that is
  the fix working.
- A changed file no test imports is no longer silently exempt from the covering-tests
  check; it falls back to the presence question.
- The MCP verify/review tools now route failures through `visp context`, matching the
  CLI; the `visp://context` resource serves the slim reading plan instead of the raw
  pack; the PR renders flip/attempt/delta evidence.
- Packed-file staleness no longer charges one task for a sibling's authorized work,
  and no longer runs on every `next`/`status` call. `visp done`'s own status flip no
  longer marks every pack stale.
- The flip check reports a scratch worktree it could not remove, stops copying visp's
  own dirty artifacts into the scratch tree, and its `auto` mode considers only the
  task's own changed files.
- `strictness: locked` now means something: strict with overrides refused. It was
  byte-identical to `strict`.
- The MCP handshake reports the built version instead of a hand-pinned constant.

### Added
- **Failure→context loop**: a failed verify or review routes the next command back
  through `visp context`; the rebuilt pack carries the failing output, unresolved
  findings, and the files the failure named.
- **Flip check** (`workflow.flipCheck: auto`): after a green verify, the task's own
  validation commands re-run in a detached scratch worktree with the task's change
  reverted. Validation that passes either way is named counter-evidence.
- **Reading-plan packs**: entity-level line ranges from the graph replace regex
  windows; the slim MCP view drops hashes and snippet text (`include: "snippets"`
  opts back in); honest token estimates; budget skips record what was omitted.
- **Install profiles**: `visp install --profile minimal` ships a ~250-token guide and
  six MCP tools for small models; profile switches prune only visp-owned files.
- **Evidence rigor at standard strictness**: a review whose every criterion went
  unchecked fails; declared expected files that did not change fail; a requirement no
  task claims refuses `tasks --validate`. Criterion `verification` must be a runnable
  command, `computed: <how>`, or `inspection: <what to look for>`.
- **Graph**: HTML pages contribute their script chain (`page_entrypoint` + import
  edges), calls into runtime globals and bound external modules stop polluting
  unknowns, barrels are chased one re-export hop for calls and test coverage,
  incremental refresh re-parses importers of changed files, and pruning VACUUMs.
- **Consumed pipelines**: `visp checkpoint` reads what `visp save` writes;
  traceability feeds the gate, the PR's per-requirement evidence trail, and the
  requirement-untasked refusal; failure-pattern proposals map the finding codes that
  actually occur.
- Delta diagnostics and an attempt counter on verify; a `repeated-failure` finding
  when the same failure survives three attempts; the session trail records
  verify/review/context/gate/index/query with refusal codes.

## 0.1.0

Initial release: the feature → spec → plan → tasks → context → implement → verify →
review → pr loop, scope enforcement via editor and pre-commit hooks, the tree-sitter
repository index, context packs, learned-skill accreditation, memory, and the MCP
server.
