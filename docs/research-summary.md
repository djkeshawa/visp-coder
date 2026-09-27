# Research summary

What VISP's own experiments have and have not shown, and the evidence behind the current design. The runs are few (usually three per arm) on tasks VISP's authors wrote, so treat them as direction, not proof. The harness, tasks, hidden checks and reference implementations are in [`bench/`](../bench/README.md).

## Question

Does an actor–critic harness with executed checks improve the code a coding agent produces, especially for weaker or cheaper models, at a time cost no higher than document-heavy workflows such as Spec Kit and BMAD?

## Current results (September 2026)

**Weaker coding agent: Claude Haiku 4.5**, run headless (`claude -p`) in its own project with project settings only, so each workflow's own instructions, skills and hooks applied. Spec Kit's phases were sent as follow-up turns and BMAD's "approve and continue" was answered, as a user would. VISP used a Codex reviewer and tester (`gpt-5.6-sol`, medium effort). Hidden checks passed and wall time, three runs per arm:

| Arm | Reservations API (44) | Spreadsheet engine (38) | Bundles on an existing service (60) | Extending an existing engine (63) |
|---|---|---|---|---|
| VISP | 44, 44, 44 · 8–10 min | 36, 35, 37 · 10–16 min | 60, 60, 60 · 5–9 min | 57, 62, 63 · 14–16 min |
| BMAD | 38, 38, 39 · 3–6 min | 33, 32, 35 · 3–22 min | 60, 60, 60 · 3–5 min | 56, 51, 50 · 7–13 min |
| Bare | 38, 39, 40 · 2–4 min | 28, 32, 26 · 5–8 min | 60, 60, 60 · 2–3 min | 51, 53, 53 · 9–11 min |
| Spec Kit | 39, 40, 37 · 10–13 min | 28, 28, 27 · 12–15 min | 60, 59, 59 · 8–11 min | 56, 59, 41 · 11–13 min |

Two earlier VISP rounds on the extension task scored 63, 63, 57 and 62, 56, 57. The tasks:

- **Reservations API:** inventory reservations with expiry, idempotency keys, confirmation and concurrency; 36 HTTP checks plus 8 contract checks the first oracle missed. Oracles were validated against a correct and a deliberately racy reference.
- **Spreadsheet engine:** precedence, right-associative powers, ranges, error-propagation order and cycles; cases computed by hand from the contract and matched by a reference.
- **Bundles:** a change to an existing multi-module service, with the prior contract as regression.
- **Extending an existing engine:** text and concatenation, comparisons, a lazy `IF`, `COUNT`, absolute references and `COPY`/`FORMULA` with reference moves; 37 existing cases as regression plus 26 new. Every arm's most common failure was a regression: extending the reference syntax broke `#REF!` for references outside the grid.

VISP matched or beat every arm on every task, and took about as long as Spec Kit. The small bundles change did not discriminate: every arm solved it.

**Stronger coding agent: Codex `gpt-5.6-luna` at low effort,** three runs per arm, after the Codex host fixes below:

| Arm | Spreadsheet engine (38) | Extending an existing engine (63) |
|---|---|---|
| VISP | 37, 36, 38 · 6–8 min | 62, 53, 57 · 8–9 min |
| Bare | 36, 33, 31 · 1.5–2.5 min | 59, 56, 55 · 3–4 min |

The gain was smaller and mixed. The 53 run declared the program itself as its check and never ran `visp done`, so it was never reviewed. On the reservations and bundles tasks, earlier two-run rounds tied (bare 44, 44 and VISP 43, 42 of 44; 60 each on bundles).

## What made the difference

**The harness must launch the critic itself.** In the first weak-agent pilot (Luna at low effort, a sentiment API with 36 hidden tests), bare coding scored 36 and both VISP arms 34: workers never ran a check that covered errors and never delegated review. A critic launched by VISP (`codex exec`, read-only) on the same code reported the two missing 405 responses, acceptance of `NaN` and a request that can hang without `Content-Length`, each with a next check. VISP now launches the reviewer after checks pass (`critic.launch: codex-exec`).

**Reviews found what hidden tests later confirmed.** Every non-VISP Haiku run on the reservations task missed at least one of: booleans used as numbers, Content-Type parameters, 405 for a wrong method. The first three reviews found all of them; later ones raised untested edge cases, so the default budget is three reviews. Findings still open at the handoff were real contract violations, not reviewer strictness: on the eight checks the first oracle missed, VISP runs scored 6–8 and other arms 3–6.

**The loop had to run inside real hosts.** Rounds with weak workers exposed, one at a time: the host killing a review that ran inside `done`; workers editing during a background review, which discarded it; sandboxes denying sockets to checks and network to the reviewer; a read-only Codex home; a reservation that rewrote every tracked file under a read-only `.agents/`; and Codex's sandbox ending VISP's background reviewer and tester. Each is fixed: sandbox denials are environment failures with a rerun-with-escalation instruction, the reviewer checks it can reach its model before a call is reserved and uses a private Codex home, and from a Codex worker's CLI the reviewer and tester run inside the command.

**Workers stop early unless the host sends them back.** Headless workers left slices open, one hand-edited the brief and another deleted `.visp/` to get past a scope error it could not read. VISP now installs Stop hooks for Claude Code and Codex that send the worker back to unfinished work, refuses agent edits and deletions of its state, names out-of-scope files in scope errors, lets a fresh reviewer close a repaired finding against current passing executions, and ends the loop in acceptance or a handoff to `visp pr` once the review budget is spent.

**Independent tests are only as good as the request they see.** Workers passed 187–238-character summaries of a 2,700-character contract to `visp feature`, and a tester writing from a summary missed the same gaps as the worker. VISP now takes the request from the host's recorded prompt (the Claude Code hook, or the Codex session file) and accepts a worker's text only as a verbatim quote. Written from the full contract, a tester suite (15 tests, about 2.5 minutes at medium effort) caught the boolean, Content-Type and 405 defects in every weaker arm. Against a correct reference it first failed five cases (a helper that sent no body where it meant JSON `null`, and extra fields the contract leaves open); after the tester was told to leave out open cases and trace cases through its own helpers, one defensible case remained.

**Frozen tests are harmful when they are wrong.** On the bundles task the first runs with the tester scored 60, 10 and 59: pinned suites assumed an error body and a status code the repository contradicts, and two workers changed correct code to satisfy them. A binding-documentation prompt, an LLM audit of the assertions (it missed both contradictions at medium and high effort) and an existing-behavior check did not make suites for existing code reliable, so the tester runs for new projects only by default. The opt-in execution mode, where the tester runs the existing program in a copy and must pass tests of existing behavior first, produced 11 correct suites of 14 against reference implementations; the other three assumed wrong setup, status codes or error bodies.

**Ceremony, not implementation, was the time cost.** In early timed-out runs, VISP replies were 76–83% of the model-visible context before the first edit, tool definitions were 44k characters per turn, and every run had briefs rejected for natural field names. Tool definitions are now about 21k characters, closed-slice replies went from 14k to 1k characters, briefs are normalized, and the light path (`visp work --check`, one slice for the whole request) replaced about six minutes of planning on small changes. The tester no longer blocks `work`, and the reviewer runs at medium effort, which matched high on hidden tests (36/36 in three runs each) at 12.0 instead of 14.2 minutes.

**Browser journeys found real defects** that unit tests missed: clipped controls, a launch that never fired, a second shot that never registered. Syntax-only checks (`node --check`) are not accepted as functional evidence.

**A bundled testing skill gave a small, uncertain gain.** `edge-cases-first` asks the worker to pin current behavior and the request's edge cases as tests before changing code. The first round exposed two delivery faults: an over-budget pack dropped skills before source excerpts that the compact reply never shows, and a skill arrived as one escaped JSON string. With both fixed, Haiku on one build, three runs per arm (control, then with the skill seeded and admitted): reservations 44, 40, 41 and 43, 44, 43; spreadsheet engine 36, 36, 36 and 37, 37, 37; extending an existing engine 58, 63, 62 and 63, 58, 58. That is 420 of 435 hidden checks against 416, at 20% more wall time and 26% more output tokens. No worker pinned existing behavior before editing, and the `#REF!` regression the skill targets appeared in one run of each arm. The skill stays opt-in.

**Stored knowledge helps only when VISP delivers it.** A two-session task (`bench/tasks/conventions-carryover`) states four API conventions for all later work in the first request; a fresh second session gets the next request with "our conventions from before still apply". Hidden checks split conventions the first session's code shows (27 checks over three runs) from ones only the conversation states (24). Haiku, three runs per arm, each second session paired on one first session:

| Second session | Code-shown | Stated only |
| --- | --- | --- |
| VISP state reset | 0–18 | 3–9 |
| VISP state kept (feature records hold the conventions) | 1–11 | 3–10 |
| Conventions restated in the request | 25–27 | 23–24 |
| State kept, with project rules | 25 | 24 |

No worker ever ran `visp learn`, and workers that read a README stating the conventions still missed them half the time. Project rules close the gap: `visp feature` captures rules stated for later work from the recorded prompt and every later feature's request and `work` reply carries them. The same rounds exposed two workflow defects, now fixed: an edit authorization left by a first session's handoff let a later session edit for a new request without starting a feature (three of nine second sessions), and a worker discarded a previous session's uncommitted work with `git checkout` to get the clean tree `visp feature` asked for.

Rules must be read by a model, not matched by phrase. Phrase matching found 4 of 18 held-out prompts that stated lasting rules; the reviewer's model at low effort found all 18, recorded nothing from 12 ordinary requests and, once told that instructions for carrying out a request are not rules, nothing from benchmark boilerplate. With the conventions restated as prose (`conventions-carryover-prose`), fresh second sessions applied 24 of 24 stated-only checks (26 of 27 code-shown) against 0 and 9 with VISP state reset.

**Visp Memory carried decisions that were not stated as rules.** In `archive-carryover` the first request specifies item archiving: an archived item cannot be reserved, and items hold at most 10,000 units. The second request adds bundle reservations and restocking without mentioning either. Three runs, second sessions paired on one first session each, no project rules captured (correctly: nothing was stated for later work):

| Second session | Carried decisions (18) | Mean time | Output tokens |
| --- | --- | --- | --- |
| VISP with project rules | 9 | 8.2 min | 34.6k |
| VISP with Visp Memory (`memory.service`) | 18 | 7.3 min | 28.2k |
| Decisions restated in the request | 18 | 11.2 min | 33.6k |

Without memory every run kept the archive check, which the reservation code already had, and none capped restocking. Visp Memory's keyword selection is coarse (scores 0.55–0.72 for relevant and boilerplate paragraphs alike), so VISP drops what the new request already says; five decisions reached each second request.

**A noisy store needs a model to choose.** The same task with ten earlier feature requests on the service already in Visp Memory (eight unrelated, two near-miss limits of other endpoints), three runs paired on one first session each:

| Second session | Carried decisions (18) | Notes the request carried | Near-miss notes carried | Mean time |
| --- | --- | --- | --- | --- |
| No memory | 9 | 0 | 0 | 8.5 min |
| Visp Memory keyword selection | 15 | 15–24 | 1 | 9.1 min |
| Reviewer's model choosing among candidates | 18 | 3 | 0 | 10.6 min |

Keyword relevance scored needed decisions and noise alike (0.54–0.57) and once cut the needed quantity limit. The model reads a wide candidate set (about 45 notes, some fourteen seconds at low effort); told that a resource's invariants apply to every operation on it while one endpoint's limits do not, it chose exactly the three decisions in every run. An earlier prompt without that distinction dropped the limit in one run. Workers ignored the near-miss note they were given, but carried 5–8 times more text. Times vary by several minutes between rounds and are not a result.

**An outdated decision stayed out when the model chose.** After the first session, a simulated intermediate feature raised the item limit from 10,000 to 50,000 units: its code change committed and its request recorded after the first one, with the ten noisy features also in the store. The same three first sessions, scored against 50,000 (21 carried checks, including restocking past the old limit):

| Second session | Carried checks (21) | Old limit delivered | Restock limit coded |
| --- | --- | --- | --- |
| No memory | 12 | — | none in 2 runs, 10,000 in 1 |
| Visp Memory keyword selection (15–16 notes) | 17 | 3 of 3 runs, beside the new one | 50,000, 50,000, 10,000 |
| Reviewer's model choosing (2–3 notes) | 21 | 0 of 3 | 50,000 in all 3 |

The run that coded 10,000 with keyword selection also restored 10,000 without memory, from the first session's traces, so keyword memory's harm is not shown; the model's choice, which stated only the new limit, kept that run on 50,000. The intermediate request said "replacing the 10000 limit"; a change stated less plainly is untested.

**No demonstrated benefit yet** from the repository graph or `visp learn` notes in any run. They remain optional.

## Design consequences

- VISP launches the independent reviewer after checks pass, and an independent tester that writes acceptance tests from the verbatim request before work starts (new projects by default); pinned tests change only through a recorded intent change.
- The request comes from the host's recorded prompt, not the worker's summary.
- A slice must declare a runnable check before edits are authorized; the light path makes that one command for small requests.
- The loop always ends, in acceptance or a handoff document, within three reviews by default; host Stop hooks send the worker back until then.
- Replies are compact; complete results stay behind `--json` and `detail: true`. Brief input is normalized for common alternative field names.
- Reviewer web search and the opt-in tester's networked commands are logged and listed in `visp pr`.

## Evidence from other work

Independent studies point the same way: execution feedback against fixed tests is the strongest lever (TDFlow; SWT-bench), self-critique without external signals is weak (Olausson et al., ICLR 2024; Kamoi et al., TACL 2024), passing tests often do not mean mergeable code (PatchDiff; METR 2026), heavy specification documents add large review overhead for small gains, and fewer, smaller tools help (RAG-MCP).

## Limits and next steps

- Three runs per arm on four tasks the authors wrote; differences of one or two checks are within run-to-run noise.
- The reviewer is a stronger model than the weak worker. Part of VISP's gain may come from that model rather than the loop; a same-model reviewer ablation has not been run.
- The opt-in tester for existing codebases needs more trials, including with its newest rule that tests of existing behavior must use every assertion helper the new tests use.
- Stronger workers gain little on these tasks; harder tasks, such as stateful browser games and larger multi-module changes, and blind code review scored separately are still to come.
