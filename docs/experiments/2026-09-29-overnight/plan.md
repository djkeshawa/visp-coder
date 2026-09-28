# Overnight improvement run — plan (2026-09-29)

Goal: VISP scores higher than BMAD and Spec Kit on bench/tasks, especially slingshot-game, at reasonable time.

## Step 0: brief review and answers

A separate review agent (Sonnet 5.5) read the brief. Its points and the answers adopted (the user was asleep; none of these changes the goal, so none needed a question):

| # | Point raised | Answer |
|---|---|---|
| 1 | `run_carryover.py` drives only Claude workers, so conventions-carryover (and 4 holdout tasks) has no luna runner; the harness may not be edited. | A driver outside the repo (`$VISP_BENCH_RUNS/night/night.py`) composes the unchanged harness scripts: `setup_arm.py`, then `run_codex.py` for session 1, then a copy of the finished project with the task's `prompt2.txt` run again with `run_codex.py`, then `score.py`. Harness and tasks are untouched. |
| 2 | What is one run of a two-session task? | Session 1 plus one second session in `fresh` mode (the project exactly as session 1 left it — the realistic case). Score = the second session's hidden checks, all groups. Time = both sessions. Each rep repeats session 1. |
| 3 | Arm strings. | VISP arm is `visp-codex:<build>`; every build is frozen from a commit with `build_visp.sh` (never the working tree). Spec Kit (`specify` 1.0.10) and BMAD (`bmad-method@6.12.0`) as setup_arm installs them. |
| 4 | "luna 6 medium" model id. | `gpt-6-luna`, `model_reasoning_effort="medium"` (verified working), passed identically to every arm by the driver. Earlier high/low rounds are not baselines. |
| 5 | VISP's reviewer/tester is extra compute. | It is part of VISP; token use and time are reported per arm. |
| 6 | Budget: 60 baseline runs + 20 VISP runs per iteration + 90 holdout runs does not fit a night. | 8 parallel workers. Baseline for Spec Kit and BMAD is run once (they do not change). Each iteration reruns only VISP on the tune set. Six iterations are a ceiling, not a target. If time runs short, the holdout uses fewer reps and says so. |
| 7 | Rate limits / infrastructure failures would read as low scores. | Runs with `isError` or a driver FAIL are infrastructure failures: rerun, never scored. On a rate-limit error, drop to fewer workers. |
| 8 | Timeouts change scores. | Same 3600 s cap for every arm; a timed-out run is scored as it stands and flagged. |
| 9 | Power and ceiling: arms sit within ~1 point of max; 5 reps cannot see small gains. | Primary metric per task = total hidden checks passed (all groups), mean and min–max over 5 reps. A change is kept only if the tune-set mean gain exceeds the baseline run-to-run spread (per the brief) with no task's mean dropping by more than its spread; otherwise "no detectable effect". A null result is reported as such. |
| 10 | Score mixes groups. | Total is primary; group breakdown (core / ui / new / code / memory / ext) reported beside it. |
| 11 | Failed-check names leak hidden content. | Names are harness output and are reported, but changes are designed from root causes found in worker transcripts, VISP state and project code — never shaped to a check name. VISP changes must be generic (no slingshot-specific logic). |
| 12 | Holdout is correlated with the tune set (variants of the same tasks). | Split kept as given; reported as a partially correlated holdout. |
| 13 | Holdout scope. | Run once at the end: final VISP build, and Spec Kit / BMAD, 6 tasks. archive-carryover-raised needs its intermediate step, which the driver takes from `run_carryover.apply_intermediate` unchanged. |
| 14 | Placeholders. | [X] = develop 74e8e0f (build `visp-nb0`); [5] = 5 reps; [6] = 6 iterations max. |
| 15 | Change reviews. | A fresh review agent per change, given the diff, the goal and the rules. |
| 16 | Work on develop, builds from commits. | Changes are developed in worktrees, reviewed, merged into develop, then frozen as a build before benchmarking. |
| 17 | Cleanup commits can regress VISP. | Behavior-neutral commits (tests, dead code) are validated by the full test suite and ride in the next benchmarked build, which would show a regression. |
| 18 | Slingshot scoring needs a browser. | Chrome is used by the hidden checks via score.py; the scorer has its own 600 s timeout. |
| 19 | "Stop and research" has no budget. | ~1 hour of analysis/research, recorded, then proceed or stop. |
| 20 | Reproducibility. | Every run appends run name, arm, build, model/effort, time, timeout flag and group scores to `night/results.jsonl`; the report is generated from it. |

Other facts that shape the plan:
- Improvement agents: Sonnet 5.5 through the Agent tool (`model: sonnet`), instructed to work at high effort; the tool cannot set an explicit effort level for a built-in agent type.
- Hidden check files (`hidden_test.py`, `hidden_game.mjs`) and `bench/reference/` are never opened by me or any agent.

## Work plan

1. Baseline round `nb`: tune set × {Spec Kit, BMAD, VISP@74e8e0f} × 5 reps.
2. In parallel: (a) root-cause analysis of VISP on slingshot from the prior round's runs (VISP state, timings, reviewer findings); (b) test-suite audit (speed, flakiness); (c) dead-code removal in its own commit.
3. When the baseline lands, analyze VISP's own baseline runs the same way (where time went, what the reviewer/tester found, why checks failed in product terms).
4. Iterate: one change per commit, reviewed by a separate agent, frozen build, VISP × tune set × 5 reps, compare with baseline. Keep only changes that beat baseline by more than the spread. If scores drop or the game gets weaker: stop, find the root cause, change approach. Two iterations without gain: stop and research.
5. Holdout once at the end, then the report (`report.md` beside this plan).
