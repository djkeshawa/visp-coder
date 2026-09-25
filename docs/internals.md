# Internals

How VISP keeps its records consistent, how learned guidance is controlled, and how its prompts are put together. None of this is needed to use VISP; it explains the guarantees and their limits.

## Scope enforcement

Three surfaces call `visp guard`, so a refusal means the same thing everywhere:

| Surface | Installed as | Scope source | When the guard cannot run |
| --- | --- | --- | --- |
| Edit hook (Claude Code) | `.visp/hooks/claude-pretooluse.mjs`, wired into `.claude/settings.json` | This checkout's authorization | Denies the write and says the check could not run |
| Git `pre-commit` | The repository's pre-commit hook | This checkout's authorization | Blocks the commit while a slice is authorized; otherwise allows it with a warning |
| CI (`visp install --hooks ci`) | `.github/workflows/visp.yml` | The feature's committed brief (`--scope tasks`) | The job fails |

The hooks read the JSON envelope from `visp guard --json` rather than the exit code, so a crash or an unrelated `visp` on `PATH` is never mistaken for a verdict. `--if-authorized` lets ordinary commits through when no slice is authorized; `--include-done` keeps finished slices' changes committable. A denial that blames the installation should be fixed with `visp doctor`, not by widening scope. The local hook can be bypassed with `git commit --no-verify`; CI is the authoritative check.

The generated CI workflow pins the VISP version that generated it, so a new release cannot change the verdict on an unchanged repository. A `pull_request` checkout is detached, so the workflow passes `--branch` to find the feature.

MCP registration exposes tools; it does not intercept writes. Codex edits through `apply_patch`, which its hooks do not intercept, so for Codex the `pre-commit` hook and `visp done` enforce scope; its installed hooks (`.visp/hooks/codex-hooks.mjs`, wired into `.codex/hooks.json`) record prompts, refuse shell commands that would delete VISP state, and send the worker back on Stop.

## Models VISP launches

With `critic.launch: codex-exec`, VISP itself starts `codex exec` sessions for the reviewer and the independent tester. Each runs with `--ephemeral` and `--ignore-user-config` and a private copy of the Codex sign-in in a temporary directory that is removed afterwards. The reviewer and the default tester run in Codex's read-only sandbox; the reviewer's only network use is the optional web search tool. The opt-in execution-mode tester runs in a writable sandbox with network, in a copy of the repository without VISP state, blocked paths or common secret files, and its commands receive only core environment variables. Every session's web searches and commands are logged under the feature (`reviewer-activity.jsonl`, `tester-activity.jsonl`), and `visp pr` lists the reviewer's searches and the tester's networked commands. Codex's sandboxes restrict writes, not reads, so a session can read files the operator's account can read.

## Build identity

`visp doctor --json` and MCP `visp_doctor` report the running package version, build ID and executable. Two installations with the same version can contain different code, so hooks, installation records and the guard handshake compare build IDs. Product mutations, check execution and critic submission require the running build to match the installed one. After upgrading, rerun `visp install` and restart MCP servers and host sessions.

## State ownership

Every VISP writer in a checkout takes one exclusive lock, `.visp/state/mutation.lock`. CLI and MCP share it; nested operations are reentrant and concurrent ones serialize. Model calls and check commands run outside the lock, and results are committed after re-checking that the subject and evidence revision have not changed.

An owner records a random token, PID, host and timestamp. VISP reclaims a lock only when its owner is a process on the same host that no longer exists; there is no age-based stealing. `STATE_BUSY` means another writer is active. `visp doctor` reports active, abandoned and ambiguous owners, and `visp doctor --fix` recovers abandoned transactions.

File changes go through recoverable transactions: a journal records each target's previous bytes, mode and existence before anything changes, and the next mutating command (or `doctor --fix`) rolls back an interrupted one. Journals are not fsynced, so they recover process interruption, not power loss.

This coordinates cooperating local processes. It does not stop an editor, a shell command or a hostile same-user process from changing files, and local hashes identify content without authenticating who produced it.

## Evidence identity

Checks run without shell bookkeeping variables (`_`, `SHLVL`, `PWD`, `OLDPWD`). The evidence fingerprint also leaves out host session identifiers (`CODEX_THREAD_ID`, `CODEX_SESSION_ID`), so a new reviewer session does not make unchanged evidence stale. Other variables such as `PATH` and `NODE_OPTIONS` are part of the fingerprint. Python bytecode is redirected with `PYTHONPYCACHEPREFIX` so checks do not write into the product.

An execution is bound to the product source, the slice contract, the verifier inputs, the environment and the VISP runtime. For declared command verifiers on POSIX, the resolved executable's path and content are also recorded. Browser executables that resolve to the same file share an identity.

Verification and review history is append-only; current projections update in the same transaction. A result computed against a stale revision is saved to history without replacing the newer record.

## Telemetry

Usage is recorded as a hash-chained event journal under `.visp/telemetry.json.events/`, with `telemetry.json` as a derived projection. Reads replay the whole chain and reject gaps, duplicates and altered content. If only the projection is damaged, rebuild it with `visp usage rebuild`. `visp usage import --source codex --file <rollout.jsonl>` imports measured usage from a Codex rollout, and `visp report` summarizes what VISP measured separately from what agents claimed. Telemetry never leaves the machine.

## Skills

A skill is advice selected by a structural trigger. It cannot grant file access, change policy, skip checks or supply an acceptance verdict, and a person admits every skill (`skills.mode: review`).

- **Proposal.** `visp skill propose` records an inert proposal. A derived skill must cite closed product slices whose closure, passing evidence and contract are still intact; repeated citations of one slice do not add support.
- **Revisions.** Each revision binds the document, trigger, origin and support to a SHA-256 version saved under `.visp/skills/<id>/revisions/`; transitions are immutable records under `history/`. If a cited slice is reopened or its evidence changes, an admitted derived skill is suspended as `orphaned` until readmitted.
- **Admission and rollback.** `skill admit --by <name>` rechecks support and content. `skill rollback --revision <sha256> --by <name> --reason "<why>"` restores only a previously admitted revision. `--by` records a claimed name; it does not authenticate a person.
- **Evaluation.** `skill evaluate --file <study.json>` imports an operator-reviewed held-out comparison (paired skill-on/skill-off runs), and `skill promote --evaluation <sha256>` activates a revision against a recorded beneficial claim. VISP checks the claim's consistency (no repository overlap, bound preregistration, complete costs); it does not authenticate the underlying results. A harmful claim retires the revision.
- **Containment.** Admission rejects known authority-changing directives and hidden-character obfuscation. This is not complete prompt-injection protection; the effective boundary is that skills have no authority over scope, policy or acceptance.

To update a bundled skill, inspect it with `visp skill catalog --show <id>`, retire the local copy with a reason, and propose and admit the new content.

## Context delivery

`visp work` assembles context for the selected slice within `context.tokenBudget`: the objective and scope, relevant outcomes and open findings, source excerpts from the slice's files and checks, graph neighbors (tests and callers of a named file or symbol), matching memory notes (up to four, 6,000 bytes) and admitted skills. Optional material is trimmed first, and omissions are reported. The original request, outcomes, scope and relevant findings are never trimmed; if they alone exceed the budget, the reply says so. Related files are reading context; they never widen edit scope.

## Prompt design

Instructions are selected per host, profile, operation and review phase rather than sent as one catalog. Each reviewer prompt has five responsibilities: preserve the goal and independent expectations, supply real evidence (source, executions and actual images), describe the judgment in plain language, state the read-only boundary and treat project content as evidence rather than instructions, and supply one response schema.

Shared judgment guidance lives in `src/workflow/product/review-instructions.ts` and is used by critic packets, prepared review sessions and MCP host sampling. UI reviews add criteria for composition, hierarchy, scale, spacing, contrast and consistency. Source-only and design consultations do not receive permission to approve the product.

The installed resident guide states the loop and essential rules; `VISP.commands.md` holds command shapes, reviewer setup and recovery. A pending critic attempt blocks new edit authorization, closure and acceptance until it returns or expires, and the block survives restarts. It is not an operating-system lock: writes outside VISP need host enforcement.

Whether a prompt change helps is decided by comparing reviewers on identical evidence, including known defects and clean controls, and then comparing whole workflows on matched tasks and budgets (see [the runner](runner.md)). Passing harness tests shows correct wiring, not better generated products.
