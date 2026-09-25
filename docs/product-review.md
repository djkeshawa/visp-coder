# Product review

This page covers browser journeys, ad hoc capture and review sessions: how VISP observes a running product and how a reviewer's judgments are recorded against that evidence. For the brief and the check gate, see [the workflow guide](workflow.md). For the independent reviewer, see [the critic guide](critic.md).

## Browser journey checks

Put a repeatable journey directly in the brief and list its check ID in the slice's `checks`. `visp done` and `visp verify` execute it and record its operations, measurements and screenshots:

```yaml
checks:
  - id: C002
    command:
      kind: browser-journey
      journey:
        url: http://localhost:3000/
        viewport: { width: 390, height: 844 }
        actions:
          - { kind: click, selector: '#start', capture: true }
          - kind: wait-for
            selector: '#game'
            attribute: { name: data-state, value: playing }
            timeoutMs: 5000
            capture: true
    outcomes: [O001]
    files: [index.html, src/game.js]
    environment: browser
```

Use the application's real selectors, states and files. An HTTP(S) application must already be running. Journeys run in an installed Chrome/Chromium (`CHROME_BIN`, or `google-chrome` by default) with an isolated profile and the browser sandbox enabled; VISP never downloads a browser or uses your open session.

A `file:///…` URL works when every loaded file is a regular, non-symlinked file inside the project and outside blocked paths. Workers, popups and downloads are unsupported in this mode; use a local HTTP server for those applications.

Each journey records an initial capture, runs its actions and records the final state. Limits: 60 seconds and six captures per journey, 10 seconds per wait.

## Actions

| Kind | Use |
| --- | --- |
| `click`, `tap` | Activate a control; optional `position: {x, y}` (0–1, relative to the element's border box) |
| `move` | Move the pointer to an element or relative `position` |
| `drag` | `selector`, viewport-pixel `to` and optional `from`, `input: pointer\|touch`, `steps`, `durationMs`, `captureDuring`, `cancel` (touch only) |
| `scroll` | Bring an offscreen control into view; optional `block: start\|center\|end\|nearest` |
| `key` | Press a special key or a single letter/digit |
| `resize` | Change the viewport within the same session, keeping application state |
| `wait-for` | Wait for `visibility: visible\|hidden\|absent`, `enabled`, exact `text` or `attribute: {name, value}`; `timeoutMs` up to 10,000 |
| `wait` | Fixed `durationMs` delay (use only when a known deadline matters) |
| `compare` | Read two values in one browser task and check a relation |

Mark an action with `capture: true` when its rendered state matters. Pointer clicks travel natively from the previous position, so aim changes along the way are exercised.

A drag with an intermediate capture:

```yaml
url: http://localhost:3000/
viewport: {width: 1280, height: 720}
actions:
  - kind: drag
    selector: canvas
    from: {x: 180, y: 360}
    to: {x: 100, y: 400}
    input: pointer
    steps: 12
    durationMs: 300
    captureDuring: true
    capture: true
  - kind: wait-for
    selector: '[role="status"]'
    text: Launched
    timeoutMs: 5000
```

A consistency check between two displays:

```yaml
actions:
  - {kind: wait-for, selector: '#resultCard', visibility: visible}
  - kind: compare
    left: {selector: '#hudScore'}
    right: {selector: '#resultScore'}
    mode: number
    relation: equal
    capture: true
```

`relation` is `equal`, `not-equal`, `less-than` or `greater-than`; ordered relations need `mode: number`. Either side can read an `attribute`; the right side can instead be a fixed `{value: "0"}`. Missing, ambiguous or blank values fail. `compare` does not poll, so use `wait-for` first when the product needs to settle.

Every capture also records bounded layout measurements: canvas scaling, clipping by ancestors, and the size and visibility of controls. They support image review; they do not score design quality.

Every journey is one fresh browser session. To test repeated use, reset or recovery, put the whole lifecycle in one `actions` array.

### Helpers for project tests

The `visp-coder/testing` export offers the same building blocks to a project's own test suite: `runBrowserJourney` and `browserJourneySchema`; `activateControl` (real pointer, touch or keyboard input) and `assertControlReachable` (size, visibility, clipping and hit testing) for a page you supply; and `assertRecovery`, `assertFiniteState` and `assertTrajectoryClose` for simulation state. They check that input reaches a control, not that the application handled it; always assert the resulting state.

## Ad hoc capture

For an exploratory observation, pass a journey on stdin:

```sh
visp capture --from - --task T001 <<'YAML'
url: http://localhost:3000/
viewport: { width: 390, height: 844 }
actions:
  - { kind: click, selector: '#start', capture: true }
YAML
```

After a repair, `visp capture --replay <run-id>` reruns a recorded journey against the current code and compares observations; a shallower new capture cannot erase a known failure. MCP `visp_capture` accepts the same journey object, or `replay`.

`visp observations --outcome <id>` lists an outcome's captured output, freshness and image paths. MCP `visp_observations` delivers the actual images.

## Failed journeys

A failed journey keeps its completed operations and the last observation: expected state, actual state, elapsed time and diagnostics, plus any partial images. Partial images never count as a successful journey. Uncaught application exceptions are recorded as behavioral failures. A failure stays open until the same journey passes on the repaired product; an unrelated successful capture does not clear it.

Browser startup and permission problems are environment failures, not product failures. For slices with browser checks, `visp work` first confirms that an isolated browser can start and capture. If it cannot, implementation may continue inside scope, but browser checks and experience review stay unresolved until the host environment is fixed (install a browser, set `CHROME_BIN`, or grant the host's permission) and `--retry-environment` succeeds.

## Prepare and submit a review

```sh
visp review --prepare --task T001
# Give the packet and its images to the reviewer, then submit its JSON:
visp review --task T001 --session <id> --from -
visp next
```

`--prepare` creates a session under `.visp/features/<id>/review-sessions/` with the original request, relevant source, current images, evidence IDs and a response schema. VISP supplies the subject identity and evidence selection; the reviewer supplies only judgments:

```json
{
  "summary": "The start interaction reaches the playing state; recovery is not yet observed.",
  "assessments": [],
  "findings": [],
  "limitations": ["Recovery needs an observation before acceptance."],
  "resolutions": []
}
```

This example is deliberately unresolved. A real response fills `assessments` with the packet's outcome and expectation IDs, a status (`satisfied`, `failed`, `unclear` or `unavailable`), a reason and cited evidence IDs. `findings` (zero to three) state the problem, its consequence, the next useful check, the affected outcomes and evidence, and whether the correction is required. Optional style suggestions stay advisory.

MCP uses `visp_review` with `prepare: true`, then `session` and `response`. Submission returns a compact receipt; `--detail` (MCP `detail: true`) returns the full bundle. `recorded: true` means the judgments were saved, not that the product was accepted.

Submission revalidates the source, contract, environment and selected image bytes. If the product changed since preparation, prepare a new session. Unknown evidence IDs, images outside the selection and stale evidence are rejected. A returned review that fails validation is reported as rejected and is not retried automatically.

Other review modes:

- `visp review` (no flags) returns the current review bundle; `--group <ids…>` delivers selected image groups (each group keeps one run and viewport together).
- `--handoff` prepares a reviewer context for the host's configured model without starting one.
- `--template` prints editable judgments for the older envelope format, which remains accepted.
- `--dispatch` uses a reviewer adapter attached by an embedding host; the standalone CLI has none and records the gap.

Report `reviewer.context` honestly (`fresh`, `current`, `unavailable` or `unspecified`). These fields are attributed claims, not authenticated independence.

## What satisfies an outcome

- Every mandatory outcome and each of its expectations needs a current assessment before `accept`.
- A satisfied judgment must cite current, successful, related evidence. Failed, stale or unknown executions, and references to the original request, cannot support it.
- An expectation with a `viewport` needs an image captured at that viewport.
- A required experience outcome needs before, input and after images from an executed journey. VISP derives these links from the runner record when the reviewer cites the check's evidence ID.
- Nonvisual outcomes do not need screenshots.

## Resolving findings

Specific findings stay open until addressed with current counterevidence. Submit `resolutions: [{id, explanation, evidence}]` using the packet's open finding IDs; a general approval cannot erase a particular failure.

- `disposition: repaired` (default) needs a fresh successful rerun of the same check or journey. Command checks need declared `verifierFiles`, and the verifier must be unchanged.
- `disposition: disproved` needs a fresh successful execution and an explanation of why the finding was wrong.
- A functional repair also needs `regression`: either `{kind: checked, explanation, evidence}` citing a distinct passing behavior in the finding's scope on the repaired version, or `{kind: not-applicable, explanation}`.

If a known finding lacks sufficient repair evidence, VISP records the rest of the review and leaves that finding open with the reason in `limitations`.

For a finding with recorded execution evidence, `work`, critic packets and review sessions include a `recheck` that names the journey or check to rerun and its replay or verify command. A matching later execution is labeled `observed-unassessed` until a reviewer judges it.

A mistaken exploratory expectation (an ad hoc capture that expected the wrong thing) can be resolved inside a review submission:

```yaml
experimentResolutions:
  - runId: <failed exploratory run>
    replacementRunId: <later completed run>
    outcome: <outcome ID>
    reason: The outcome requires the terminal victory state, not an enabled launch button.
    evidence: [<replacement observation ID>, <replacement image ID>]
```

This needs a completed replacement run for the same task with a successful observation and an intact image. Declared check journeys cannot be waived this way: revise the method in the brief and rerun the same declared check.

## Correction budget and visual review

The brief's `design.refinementCycles` (default 2) bounds correction cycles after an initial finding. Cycles count assessed implementation changes after a failure; unavailable reviews, duplicate submissions and metadata edits do not spend them. Exhausting the budget never turns a failure into a pass.

For UI work, `work` schedules a first-render visual checkpoint before content expands. Review the primary activity's scale, composition, contrast and interaction feedback at the actual viewport sizes. Working controls and a consistent theme do not establish visual quality, and an image does not establish unobserved behavior.

`workflow.reviewMode: observation-preview` is an opt-in mode that gives the independent reviewer observation-first guidance and keeps selected intermediate images labeled from recorded operations. The default is `current`.
