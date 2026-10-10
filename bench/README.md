# Benchmark harness

Fixed-contract tasks for comparing coding workflows (bare coding, Spec Kit, BMAD and VISP) with the same worker model. Correctness is measured by hidden checks the worker never sees. Results are direction, not proof: few tasks, few repetitions. The results so far are in [the research summary](../docs/research-summary.md).

## Tasks

| Task | Kind | Hidden checks |
| --- | --- | --- |
| `reservations-api` | New HTTP service: inventory reservations with expiry, idempotency and concurrency | 36 core + 8 extended |
| `spreadsheet-cli` | New command-line spreadsheet engine: precedence, ranges, error order, cycles | 38 |
| `reservations-bundles` | Change to an existing multi-module service (`start/`) | 60, including the prior contract |
| `spreadsheet-extend` | Larger change to an existing multi-module engine (`start/`) | 37 regression + 26 new |
| `conventions-carryover` | Two sessions on the existing reservations service: the first states team API conventions and adds a list and an audit log; a fresh second session adds prices, retirement and a reservations list under those conventions | 20 core + 20 new + 9 code + 8 memory |
| `sheet-carryover` | Two sessions on the existing spreadsheet engine: AVERAGE and ROUND, then MEDIAN and directed rounding carrying the empty-statistic rule and digits restriction | 22 core + 14 new + 8 memory |
| `archive-carryover` | Two sessions on the existing reservations service: item archiving and a quantity cap, then bundles and restocking that must preserve those feature decisions | 15 core + 17 new + 7 memory |
| `conventions-carryover-prose` | `conventions-carryover` with the first request stating the conventions in conversational prose instead of a labelled list | as `conventions-carryover` |
| `archive-carryover-raised` | `archive-carryover` after an intermediate feature (`intermediate.md`) raised the quantity cap to 50,000, with ten unrelated earlier requests (`noise.md`) in the store; checks use the raised cap | as `archive-carryover` |
| `slingshot-game` | New browser game: drag-to-launch slingshot, physics, three levels, test hooks on `window.gameTest` | 22 core + 6 UI |
| `catapult-game` | New browser game: catapult with four projectile kinds, three materials, per-level ammunition and three levels | request only; hidden checks not yet published |

- `tasks/<task>/task.md` is the request every arm receives; `start/`, when present, is the existing codebase the project starts from.
- `tasks/<task>/hidden_test.py <project>` runs the project and prints JSON results.
- A two-session task has `session1.md`, `session2.md` and `conventions.md` instead of `task.md`. For `conventions-carryover`, its `code` checks apply conventions that the first session's code already shows; its `memory` checks apply conventions stated only in the first conversation (money in integer `*Cents` fields, soft deletion answering 410 `gone`), so they pass only if the knowledge survived between sessions. `archive-carryover` instead tests feature decisions already expressed in session 1 code: its `memory` checks apply the archived-item restriction to bundles and the quantity cap to restocking. Each memory check includes a forbidden operation, so omitting both carried decisions fails every one.
- `reference/` holds correct implementations used only to validate the oracles; deliberately broken variants (a racy store, injected bugs) were checked to fail.

## Qualifying the spreadsheet oracles

```bash
python3 -m unittest bench/test_hidden_oracles.py
```

These local checks verify that correct references pass, wrong division-error output fails,
and a nonzero program exit fails even when its output matches. They use temporary copies
and the standard library, without calling models. Oracle qualification is not a comparison
of coding workflows.

## Timing the dashboard

`bench/ui/bench-ui.mjs` times `visp ui` against the first-render and live-update targets in [the dashboard specification](../docs/specs/visp-ui.md#16-testing-and-acceptance), on a feature that `tests/integration/ui/large-demo.test.ts` seeds with 20 slices and 200 real executions. Usage is at the top of the script; results are in the specification.

## Running

Runs, builds and worker homes live outside the repository, in `$VISP_BENCH_RUNS` (default `~/visp-bench`).

```bash
bench/build_visp.sh HEAD visp-head                          # freeze a VISP commit as a runnable build
python3 bench/setup_arm.py spreadsheet-cli bare r1          # or speckit | bmad | visp:visp-head | visp-codex:visp-head
python3 bench/run_claude.py r1                              # headless Claude Code worker (Haiku 4.5 by default)
python3 bench/run_codex.py r1                               # or a headless Codex worker (gpt-5.6-luna, low effort)
python3 bench/score.py spreadsheet-cli r1                   # hidden checks; writes runs/r1/hidden.json

python3 bench/setup_arm.py conventions-carryover visp:visp-head c1
python3 bench/run_carryover.py c1 --modes wiped,fresh,oracle  # session 1 once, then session 2 per mode
python3 bench/score.py conventions-carryover c1/wiped c1/fresh c1/oracle
```

- `setup_arm.py` creates a fresh Git project, installs the arm's workflow and writes the prompt. Spec Kit needs `specify` on `PATH`; BMAD is fetched with `npx`. VISP arms use a VISP-launched Codex reviewer and tester (`critic.launch: codex-exec`, medium effort), so the Codex CLI must be signed in. `--skill <id>` seeds and admits a bundled VISP skill, so two arms on the same build differ only by that skill.
- `run_claude.py` runs `claude -p` in the project with project settings only, so each workflow's own instructions, skills and hooks apply; Spec Kit's phases are sent as follow-up turns and BMAD's approval prompts are answered, as a user would.
- `run_codex.py` runs `codex exec` with a clean home holding only the Codex sign-in and a workspace-write sandbox with network, with project hooks trusted.
- Each writes `result.json` (duration, turns, tokens) beside the project.
- `run_carryover.py` runs the first session once, records which files gained mentions of the conventions (`session1/carriers.json`) and scores it, then restores that snapshot at the same path before each second-session mode: `wiped` resets the assistant's notes (`.visp/memory`, `CLAUDE.md`, `AGENTS.md`), `fresh` keeps everything, `oracle` restates the conventions in the request, `resume` continues the first conversation. `memory` is `fresh` with Visp Memory as VISP's long-term store (`memory.service`), set up before the second session from `$VISP_BENCH_RUNS/visp-memory-venv`. Claude Code's own auto memory is disabled for every worker, so only what the project holds can carry.

A desktop app or terminal that ends its child processes can stop a long batch; start batches in their own session (for example `systemd-run --user` on Linux). On Linux both runners start each worker in its own user and PID namespace (`unshare`), so a worker's `killall python3` or `pkill -f` reaches only its own processes, not the runner or parallel runs. The wrapper is tried once first; where `unshare` is missing or the host blocks unprivileged namespaces or mounting `/proc`, workers run unwrapped (still in their own session) and are not isolated from each other.
