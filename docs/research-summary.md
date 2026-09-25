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

**No demonstrated benefit yet** from the repository graph, memory notes or the skill lifecycle in any run. They remain optional.

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
