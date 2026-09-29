# Overnight improvement run — report (2026-09-29)

Plan and Step 0 answers: [plan.md](plan.md). Everything below is from the harness's pass/fail output (`hidden.json`) and the worker transcripts / VISP state of each run; no hidden check file was opened.

## Verdict

**Good news, with caveats. The final VISP build scores highest of the three workflows on both the tune set and the holdout. On the slingshot game it scores 28/28 in every run. It is 1.3–2× slower than Spec Kit and BMAD. It still has one clear loss (stale memory) with a known root cause.**

- **Tune set (4 tasks, 167 checks), mean per rep:** VISP final **166.6**, Spec Kit 163.0 ± 4.6, BMAD 161.2 ± 2.7, VISP baseline 149.0 ± 19.7.
- **slingshot-game:** VISP final **28/28 in 5 of 5 runs**. Spec Kit scored 27.0 ± 0.7 (1 of 5 perfect), BMAD 23.8 ± 2.5, VISP baseline 25.8 ± 3.3.
- **By the brief's strict rule** ("keep only changes that beat baseline by more than the run-to-run spread"), few per-task gains clear the bar:
  - The baseline VISP spread is large because it is bimodal (carryover runs either 57 or 22), and the other arms already sit at the ceiling on 3 of 4 tasks.
  - The final build's gain over the VISP baseline (+17.6) is just under that baseline's SD (19.7).
  - Its lead over Spec Kit (+3.6) is under Spec Kit's SD (4.6).
  - What it does show clearly: zero spread, the ceiling on 3 of 4 tasks, and the removal of every failure mode found in the baseline runs.
- **Time:** VISP final averages **19.1 min per tune run**, versus Spec Kit 11.2, BMAD 10.8 and VISP baseline 12.2. Slingshot takes 35.8 min, versus 15.8 (Spec Kit) and 18.6 (BMAD). No run hit the 60-minute cap. VISP's own reviewer and tester calls are extra compute on another model and are not in the token counts.
- **Holdout (6 tasks, 303 checks, run once on the final build):** VISP **294.4 ± 0.9**, Spec Kit 284.6 ± 6.7, BMAD 285.8 ± 6.6. That lead is larger than either baseline's spread.
  - VISP wins archive-carryover (39 vs 35) and conventions-carryover-prose (57 vs 51.6 and 49.4).
  - It ties reservations-bundles and spreadsheet-extend, and sits between the two on sheet-carryover.
  - It **loses archive-carryover-raised (34 vs 36)**: its built-in request memory restored an outdated item limit (details below).
  - Holdout time: VISP 13.0 min per run, Spec Kit 10.4, BMAD 8.0.

## Setup

- **Worker:** Codex `gpt-6-luna`, `model_reasoning_effort="medium"`, identical for every arm. Same task prompt from `bench/setup_arm.py`, 3600 s cap, 5 reps per task per condition, up to 8 to 20 runs in parallel on one machine (16 cores).
- **Arms:**
  - Spec Kit (`specify` 1.0.10)
  - BMAD (`bmad-method@6.12.0`)
  - VISP `visp-codex:<build>`, with VISP's own Codex reviewer and tester (gpt-5.6-sol, medium) as `setup_arm.py` configures it
- **Two-session tasks:** session 1, then session 2 in place on the project as session 1 left it (`fresh`). Score is session 2's hidden checks, and time is both sessions. `archive-carryover-raised` also gets the harness's own intermediate step (`run_carryover.apply_intermediate`, raising the item limit and committing it) with no memory seeding for any arm.
- **Harness:** unchanged. The driver lives outside the repo: `$VISP_BENCH_RUNS/night/night.py`, plus `run_codex_keep.py`, which runs the unchanged `bench/run_codex.py` and keeps the worker transcript.
- **Improvement agents and reviews:** Sonnet 5.5 through the Agent tool. The tool cannot set an explicit effort level, so every agent was told to work at high effort. Each change got a separate review agent, and every review asked for changes that were applied before benchmarking or merge.

## Tune set

Mean ± SD (min–max) of hidden checks passed, then mean wall minutes per run and mean worker tokens (uncached input plus output). n = 5 unless noted.

| Task (max) | Spec Kit | BMAD | VISP baseline (74e8e0f) | VISP final (199b946) |
|---|---|---|---|---|
| slingshot-game (/28) | 27.0 ± 0.7 (26–28)<br>15.8 min, 145k tok | 23.8 ± 2.5 (22–27)<br>18.6 min, 174k tok | 25.8 ± 3.3 (20–28)<br>21.7 min, 221k tok | **28.0 ± 0.0 (28–28)**<br>35.8 min, 344k tok |
| reservations-api (/44) | 44.0 ± 0.0<br>8.2 min, 101k tok | 44.0 ± 0.0<br>5.5 min, 84k tok | 42.6 ± 3.1 (37–44)<br>8.2 min, 80k tok | 44.0 ± 0.0<br>10.5 min, 87k tok |
| spreadsheet-cli (/38) | 37.0 ± 1.0 (36–38)<br>7.0 min, 91k tok | 36.4 ± 0.9 (35–37)<br>6.2 min, 90k tok | 37.6 ± 0.5 (37–38)<br>8.3 min, 88k tok | 37.6 ± 0.5 (37–38)<br>8.8 min, 70k tok |
| conventions-carryover (/57) | 55.0 ± 4.5 (47–57)<br>13.8 min, 198k tok | 57.0 ± 0.0<br>12.8 min, 206k tok | 43.0 ± 19.2 (22–57)<br>10.6 min, 121k tok | 57.0 ± 0.0<br>21.3 min, 223k tok |
| **Total per rep (/167)** | 163.0 ± 4.6 | 161.2 ± 2.7 | 149.0 ± 19.7 | **166.6** |
| **Mean min per run** | 11.2 | 10.8 | 12.2 | 19.1 |

"VISP final" is the build benchmarked as iteration 6 (changes 1 to 5). On develop, change 5 was then reverted because it showed no detectable effect. The two differ only in tester and worker prompt text about ambiguities.

### VISP per iteration

| Task (max) | i1 (c1) | i2 (c2) | i3 (c1+c3) | i4 (c1+c3+c4) | i5 (c1+c2+c3+c5) | i6 final (c1–c5) |
|---|---|---|---|---|---|---|
| game (/28) | 27.4 ± 0.5 | — | 28.0 ± 0.0 | 27.8 ± 0.4 | 26.6 ± 0.5 | 28.0 ± 0.0 |
| res (/44) | 44.0 ± 0.0 | — | 44.0 ± 0.0 | — | 44.0 ± 0.0 | 44.0 ± 0.0 |
| sheet (/38) | 36.8 ± 1.3 | — | 37.2 ± 0.8 | — | 38.0 ± 0.0 | 37.6 ± 0.5 |
| conv (/57) | 36.0 ± 19.2 | 57.0 ± 0.0 | — | — | 56.6 ± 0.9 | 57.0 ± 0.0 |

An iteration ran only the tasks its change could affect. c2 only acts when a feature starts on a dirty tree, which only the two-session task's second session does. c1, c3 and c5 act through the independent tester, which is off for an existing codebase such as carryover.

## Holdout (run once)

| Task (max) | Spec Kit | BMAD | VISP final |
|---|---|---|---|
| archive-carryover (/39) | 35.0 ± 0.0 (35–35)<br>9.7 min, 182k tok | 35.0 ± 0.0 (35–35)<br>9.4 min, 172k tok | 39.0 ± 0.0 (39–39)<br>14.1 min, 156k tok |
| archive-carryover-raised (/40) | 36.0 ± 0.0 (36–36)<br>10.7 min, 184k tok | 36.0 ± 0.0 (36–36)<br>7.2 min, 131k tok | 34.0 ± 0.0 (34–34)<br>12.6 min, 152k tok |
| conventions-carryover-prose (/57) | 51.6 ± 5.8 (43–57)<br>14.2 min, 205k tok | 49.4 ± 7.1 (42–57)<br>10.0 min, 168k tok | 57.0 ± 0.0 (57–57)<br>21.7 min, 213k tok |
| reservations-bundles (/60) | 60.0 ± 0.0 (60–60)<br>7.7 min, 98k tok | 60.0 ± 0.0 (60–60)<br>4.5 min, 89k tok | 60.0 ± 0.0 (60–60)<br>7.0 min, 75k tok |
| sheet-carryover (/44) | 39.6 ± 1.9 (37–42)<br>10.5 min, 180k tok | 42.4 ± 0.9 (42–44)<br>7.2 min, 135k tok | 41.6 ± 0.5 (41–42)<br>11.3 min, 114k tok |
| spreadsheet-extend (/63) | 62.4 ± 0.5 (62–63)<br>9.8 min, 137k tok | 63.0 ± 0.0 (63–63)<br>9.7 min, 133k tok | 62.8 ± 0.4 (62–63)<br>11.6 min, 117k tok |
| **Total per rep (/303)** | 284.6 ± 6.7 | 285.8 ± 6.6 | **294.4 ± 0.9** |
| **Mean min per run** | 10.4 | 8.0 | 13.0 |

Spec Kit and BMAD holdout runs were run earlier in the night, while VISP was iterating. They don't depend on VISP, so each was still run once. VISP ran once on the final build. The holdout is correlated with the tune set: its tasks are variants or extensions of the tune tasks, and earlier VISP work had seen all ten.

## What changed (develop, in order)

| Commit | Change | Evidence and decision |
|---|---|---|
| fb026e9 | plan.md | |
| 5f974cc (merge of da34019…d98e010) | **Test-suite speed**: vitest workers 2 → up to 6; expensive fixtures built once per test file and copied; one weak assertion strengthened | Suite 1039 s → 283 s on the same loaded host; 3169 tests still pass. Behavior-neutral. A reviewer checked isolation: no path-coupled state in copies. |
| 66f53d8 (merge of aa5d4f1, e796159, 6f43017) | **Dead code**: unreferenced functions, types and zod schemas removed; about 170 module-internal exports narrowed; 6 identical helper copies consolidated (net −363 lines) | Public API `.d.ts` is identical before and after; the reviewer checked each consolidation for identical behavior. Behavior-neutral. |
| c2a88ce (c4c5c57) | **c2: start a feature on a dirty tree when Git is read-only.** Under Codex's sandbox `.git` is read-only, so session 1 can never commit. Session 2's `visp feature` was then refused ("needs a committed baseline"). VISP now probes Git writability, and if the tree is unwritable it records the earlier uncommitted work as the feature's inherited starting state. | Baseline: 5 of 10 carryover second sessions (nb + i1) were refused and delivered nothing (22/57). With c2: 0 of 15 refused (i2, i5, i6), all 57/57 except one 55. **Kept.** A bug fix, confirmed in every run's state. |
| 12bb4d6 → c1 (839671c) | **c1: tester covers central outcomes.** The independent tester must cover the effects the product exists for (scoring, winning, losing, what follows). It reaches them by an iteration-bounded search over the stated interfaces instead of skipping them. It tests stated-equivalent input paths (real pointer vs test hook) with non-degenerate geometry. | Baseline tester suites never tested destruction, scoring or winning in 3 of 3 games. One worker's late rewrite broke destruction unnoticed (20/28). In 10 of 16 finished games the pointer path's vertical axis was mirrored, and every suite dragged only horizontally. i1 alone: game 25.8 → 27.4, but spreadsheet 37.6 → 36.8 (a drop larger than spread). **Not kept alone.** Root cause of the drop: more tests meant more wrong pinned tests, which blocked `done` so no review ran. This led to c3. |
| 12bb4d6 → c3 (c9dc155) | **c3: dispute a wrong pinned test.** `visp done --dispute <test> --reason "<quote + why>"`. A failing pinned test with an open dispute no longer blocks the independent reviewer. The reviewer rules upheld (the test is waived, verified against the critic record) or rejected. Limits: at most 5 open, 2 filings per test, FAIL-line matching, adapter-observed rulings only. Tester rules added: teardown errors never fail the suite; no incidental-order assertions. | i1: 3 of 15 runs stuck on wrong or broken pinned tests (a teardown ENOTEMPTY, a key-order assertion, a formula placed inside its own range), with no review ever run. i3 (c1+c3): game 28 × 5, spreadsheet 37.2 (within spread), reservations 44 × 5. In one i3 game the tester's harness passed statements to an expression wrapper and every test failed; the reviewer correctly upheld those disputes and the run reached 28/28. **Kept together with c1.** Reviewed twice; 27 unit tests. |
| 12bb4d6 → c4 (1b05143) | **c4: labeled UI text.** One guide line ("If the request has a UI, show status, counts, errors as word-labeled text (`Score: 1500`), not only canvas/icons.") plus a low-rank reviewer check. The minimal guide budget went 300 → 329 tokens. | The HUD check ("level, score and birds are shown") failed in 9 of 20 runs without c4: status drawn only on canvas, or icon-only labels like `★ 0`. It failed in 0 of 10 with c4 (i4, i6). Against its direct predecessor (i5 → i6) the game went 26.6 ± 0.5 → 28.0 ± 0. **Kept.** |
| 12bb4d6 → c5 (49f7d15), then **reverted in 1646b68** | **c5: rule interactions.** Tester rules to test stated rule and exception combinations, and input classes in every stated position. The worker implements the tester's usual reading of an ambiguity by default. | This came from a root-cause study of 23 spreadsheet projects (below). Spreadsheet with c5: 38 × 5 (i5), then 38, 37, 38, 37, 38 (i6), a mean of 37.8 against the 37.6 baseline (SD 0.55). **No detectable effect, so reverted per the brief.** The holdout build still contained it. |

Merge-time checks on develop: typecheck and lint clean, and the full suite passes (3201 tests at 12bb4d6). After the revert (1646b68): typecheck and lint are clean, and 3201 tests pass (1 skipped, Windows-only).

## What didn't work or is still open

1. **Stale memory overrides newer code (holdout, archive-carryover-raised: VISP 34 vs 36).**
   - Between the sessions the item limit was raised to 50000 by a commit made outside VISP.
   - VISP's built-in request history still held session 1's "limit 10000". In all 5 runs the session-2 worker changed validation and restocking back to 10000, failing `create exactly 50000 succeeds`.
   - Spec Kit and BMAD kept the committed limit.
   - Earlier experiments passed this case only when the intermediate change was recorded in VISP's history.
   - Suggested fix: before delivering a recalled note, check it against the current code (or recent commits) and flag conflicts as "the code has since changed", not as a rule.
2. **Time.** VISP final is about 1.7× Spec Kit/BMAD overall and 2.3× on the game.
   - The extra time is the review loop (up to 3 reviews plus fixes) and the tester's larger suites (c1).
   - This round did not try to cut time, per the brief.
3. **Tester-written browser harnesses are fragile.**
   - One suite attached to a Chrome extension page instead of the game tab (i5), so that run's drag bug went unseen.
   - One suite built statement sequences into an expression wrapper (i3); c3's dispute path rescued it.
   - A VISP-provided browser helper for testers would remove this class of failure.
4. **Cross-run port collisions.**
   - Runs share the network namespace (the harness isolates only PIDs).
   - In i5 a VISP capture replay hit another run's game server on a fixed port (8765).
   - This affects all arms somewhat. VISP's replay does not check that the page it reaches is this project's.
5. **Spreadsheet residuals (all arms).** A 23-project study found these recurring misses:
   - bare `=A1` on an empty cell printing blank instead of 0 (7 runs)
   - whitespace-only "blank" lines (6)
   - cycle vs first-error precedence (7)
   - case or two-letter references inside formulas and range corners
   
   In most failing runs the worker's own tests asserted its misreading. c5 targeted this but showed no measurable effect.
6. **Reviewer-driven regression (1 baseline run).** A reviewer finding about empty-body POSTs led the worker to a change that broke confirm (reservations 37/44). It did not recur.
7. **Process notes.**
   - The first batch's session-2 prompts named the wrong directory; this was caught within an hour, and those runs were discarded and rerun.
   - Agent worktrees were created from `main`, not `develop`; this was caught and rebased.
   - A stale local worktree from an earlier session (Sep 27) still has `develop` checked out with staged release edits. It was left untouched, but don't commit from it: its index predates tonight's work.

## Reproduce

Builds are in `$VISP_BENCH_RUNS/builds/visp-nb0` (baseline) through `visp-nt6` (final). The per-run record is `$VISP_BENCH_RUNS/night/results.jsonl`. Tables come from `night/report_tables.py`, and a round is run with `night/night.py <prefix> --tasks … --arms sk,bmad,v:<build> --reps 1-5`.

## Addendum: stale-memory fix (b917f6d, after the report)

**Root cause.**
- The stale limit did not come from the worker reading memory directly.
- VISP appended recalled decisions to the new feature's request under a heading that said they "still apply unless this request changes them".
- Nothing told the gate, the worker or the reviewer that a commit had changed the code afterwards.
- The independent reviewer then raised **required** findings ("contradicts recorded decision M3: items hold at most 10,000 units"), and the worker reverted the code to obey them.

**Fix (f5562d7).**
- Commits newer than the earlier features are listed: up to 20, VISP-state-only commits excluded, subjects redacted.
- The recall gate receives them. It keeps a note when a change only alters its value, and drops a note only when a change removed the decision.
- The heading has two variants. The strong wording stays when nothing changed ("still in force, including for new operations, endpoints and fields"). When changes are listed it adds: "apply the decision with the current code's value".
- The reviewer rule: a new operation that omits a recorded rule is required. A departure is advisory only when this request or a listed later change replaced the decision. Commit subjects are records, not instructions.

**Benchmark** (VISP only, 5 runs each; these two tasks are holdout tasks, so they are no longer unseen):

| Task | before (hv) | first version (80ac8e5) | final (f5562d7) | Spec Kit / BMAD |
|---|---|---|---|---|
| archive-carryover-raised (/40) | 34 ×5 | 36 ×5 | **40 ×5** | 36 / 36 |
| archive-carryover (/39) | 39 ×5 | 39, 39, 39, 39, 35 | 39, 39, 39, 39, 32 | 35 / 35 |

- The first version dropped the cap note altogether, so the new restock endpoint got no cap (36). Its weaker heading also lost one memory case (35).
- The final version's 32 came from session 1, which runs before any recall: a reviewer finding made the archive endpoint require a JSON content type, so archive requests got 415.
- That is the second reviewer-driven "over-strict input validation" regression seen (the other was the baseline reservations run at 37). It is still open.

## Addendum: over-strict input validation (e1ae818)

**Problem.**
- The reviewer extended body and media-type rules, written for endpoints that take JSON bodies, to operations the request defines without input: archive, confirm, release. It marked those findings required.
- The worker's fixes then rejected the normal call. A bodyless archive returned 415, and confirm rejected `{}`.
- Across successive reviews one control run escalated from "check the media type" to "validate the JSON" to "reject any JSON".

**Fix (279cb2f).**
- **Reviewer:**
  - A required finding that asks for new input rejection must name the request sentence, contract rule or recorded decision (M#) it relies on.
  - A rule covers an operation only if it names that operation or its class, and the rule's condition holds for the request's normal call. A body rule does not cover an operation whose normal call has no body. If a rule and the described normal call conflict, the normal call wins.
  - Crashes, 5xx, state corruption and scope escapes stay required.
  - Natural variants of stated rules count as stated.
- **Worker (the `fix` objective):**
  - Add a test that the request's normal call still succeeds, and reject only what the finding names.
  - Don't apply a finding that would break the normal call; say so in the done note.

**Benchmark** (gpt-6-luna medium, 5 runs each, fix vs current develop):

| Task | control | fix |
|---|---|---|
| reservations-api (/44) | 44, 44, **37**, 44, 44 | 44 ×5 |
| archive-carryover (/39) | 39, **32**, 39, 39, 39 | 39 ×5 |
| archive-carryover-raised (/40) | 40 ×5 | 40 ×5 |
| spreadsheet-cli (/38) | 37.6 | 37.8 |
| slingshot-game (/28) | 27.6 (32.6 min) | 28.0 (42.0 min; one run hit the 60 min cap at 28/28) |

**Blind audit.** A separate agent labelled every reviewer finding that asked for new input rejection against the request text, without knowing the arm.

| | control (25 runs) | fix (25 runs) |
|---|---|---|
| Required, stated by the request | 13 | 11 |
| Required, extended or invented | 9 | 3 |

Unwarranted required findings fell by two-thirds, and legitimate ones were mostly kept. Neither arm lost any checks to the three that remained: the worker kept the normal call working.

**Game time:** the difference is within this task's run-to-run noise. The same code ran 9–54 min in the control and 27–54 min in iteration 6, and review and critic counts were similar between arms.
