import { SOURCE_DELIVERY_GUIDANCE } from "../../workflow/delivery-guidance.js";

/**
 * Curated from an upstream source (SHA-256
 * e791ca95d33ecb23d8ea27cac3f1cd978e93441b33d83af034fd9a98d786a48f) before VISP's amendments.
 * Keeping the body in TypeScript makes it part of tsup's dependency graph, so
 * published binaries do not depend on an unpackaged runtime asset.
 */
export const RESEARCH_THE_CRAFT_CONTENT = `---
name: research-the-craft
description: Investigate load-bearing uncertainty before it becomes a design, implementation, or testing mistake. Start with repository evidence and search externally only for unresolved or version-sensitive facts.
appliesTo:
  stage:
    - context
    - implement
---

## Purpose

\`research-the-craft\` is an uncertainty-driven investigation skill. It helps
an agent answer a question that could change the behavior, design, algorithm,
stack choice, failure fix, or test plan. It is not a recipe for imitating a
reference product, and it is not a requirement to research every brief.

Start with the smallest uncertainty that could make the current decision wrong.
Investigate until that uncertainty is resolved enough to choose, test, or record
it as open. Stop when the decision is supported; do not keep collecting sources
to satisfy a quota.

## When to use

Use during context gathering or implementation when an unresolved question
could change the next decision. Read the current product brief first. Record
useful conclusions in its decisions, checks or uncertainties, preserving the
original request and slice scope. Rebuild context when a decision changes.
This skill is advisory. Its selection does not require an investigation when
local evidence already settles the question. Stop once the next action is
supported; do not restart a broad survey or expand the task.

Do not use this skill when the answer is already established in the repository,
the brief is fully decided, or the uncertainty is too small to affect the work.
Do not turn a missing source into permission to guess. Record it as unknown.

## Choose an investigation mode

Name one primary mode before gathering evidence. Combine modes only when the
question genuinely crosses their boundary.

- **greenfield/domain** — Establish the domain's user goals, workflows,
  invariants, terminology, constraints, and meaningful choices before proposing
  a new shape. Product comparisons are optional and useful only when they settle
  a domain decision.
- **brownfield/repository** — Explain how this project already behaves. Trace
  the relevant code, tests, configuration, data shapes, callers, history, and
  failure paths before proposing a change.
- **stack/API** — Confirm the versions, installed surface, supported idioms,
  compatibility constraints, and API behavior that the project can actually
  use. Do not assume that a current-looking example matches the locked version.
- **algorithm/logic** — Derive invariants, boundaries, failure cases, state
  transitions, units, accepted input ranges, reachable outcomes, and time or
  space costs. Prefer a small executable check or counterexample over a
  persuasive explanation. If preview, prediction, and runtime represent the
  same behavior, identify their shared source of truth or test their agreement.
- **UX** — Investigate the user task and observable states, including empty,
  loading, error, keyboard, accessibility, responsive, and feedback behavior.
  Use visual comparison only to settle a concrete UX uncertainty, not to copy a
  surface.
- **failure investigation** — Reproduce the failure, compare expected and
  actual behavior, trace the smallest causal path, test competing hypotheses,
  and preserve a regression scenario. If it cannot be reproduced, say so and
  keep the cause open.

## Evidence order

For an existing project, repository-first is mandatory. Inspect the relevant
files, tests, configuration, lockfiles, local documentation, call sites, and
history; run the narrowest useful check or reproduction. The repository is the
best evidence for how this project works, even when a generic convention says
otherwise.

Use external search only for unresolved or version-sensitive questions. Prefer
the official documentation, source, release notes, standards, or other primary
material, and record the version or date that makes the source applicable.
External search is not a default step and is not a substitute for reading the
repository. Do not search for reference products unless a greenfield/domain
comparison will change a decision.

For a greenfield question with no repository, state that local evidence is
unavailable. If that leaves the domain question unresolved, use the narrowest
authoritative domain sources needed. For stack/API questions, inspect the
manifest, lockfile, installed types or source, and existing usages before
consulting current external documentation.

## Investigation loop

1. **Frame the uncertainty.** Write the decision, the competing possibilities,
   what would change if each were true, and the smallest useful stopping rule.
   Treat a question as consequential when a wrong answer would change
   outcomes, architecture, checks, slices, or scope.
2. **Select the mode and evidence order.** Begin with repository evidence for
   brownfield work. Treat a local test, source path, command result, or checked
   type as stronger than a generic example.
3. **Gather only decision-relevant evidence.** Separate observed facts from
   inferences and from recommendations. A disagreement is evidence about the
   decision, not a reason to average the sources.
4. **Search externally only when justified.** Explain which local question
   remained unresolved or which version-sensitive fact needed confirmation.
5. **Write compact evidence receipts.** Keep one receipt per consequential
   source or check, not a research diary. Use this shape:

   \`\`\`
   question: the uncertainty this bears on
   source: repository path and line, command/test, or URL plus version/date
   finding: the observed fact, kept separate from inference
   consequence: the decision it supports, limits, or leaves open
   \`\`\`

   Receipts should be short enough to scan. Never invent a source, turn memory
   into a citation, or present an inference as an observation. If evidence is
   partial, say what it does not establish.

   In the current product brief, connect each consequential decision to its
   evidence and rationale. Record the bounded challenge that tried to verify
   or disprove it. Repository traces cite repository evidence; experiments
   cite actual executions. User decisions establish constraints or preferences,
   not technical truth. State the observable result that would falsify the
   claim. Experiments identify boundary and counterexample cases; a cost or
   performance bound cannot establish behavioral correctness. An inconclusive
   challenge leaves an uncertainty open.

6. **Route the finding.** Carry only findings that affect the work into the
   project artifacts described below, then stop or add the remaining question
   to \`uncertainties\`.

## Translate research into engineering structure

Research is incomplete until it changes the shape of the implementation or its
checks. Before implementation, name the responsibilities, state owner,
invariants, module boundaries, and contracts that the finding implies. Prefer a
small cohesive module over a catch-all file. File size is an inspection signal,
not proof of architecture or a reason to invent additional modules. Code with different owners, lifecycles,
callers, failure modes, or test boundaries should split. If one responsibility needs
several files, group them in a meaningful module folder that follows the
repository's conventions. Do not manufacture folder depth or split code merely
to reduce line count. Each boundary must have a reason and a caller.

${SOURCE_DELIVERY_GUIDANCE}
Keep authored source normally formatted; do not compact it to satisfy a line
ceiling. Formatting and test-file counts do not prove modularity.

When domain/state rules, presentation, and boundary wiring have different state
owners or failure modes, plan them as distinct responsibilities and bounded
tasks. The integration task proves the connector; it does not absorb all three
responsibilities into one implementation batch.

Choose evidence as a pyramid rather than one broad green command:

- unit checks pin down local rules, calculations, and state transitions;
- integration checks exercise module contracts, connectors, persistence, and
  event flow across a real boundary;
- functional checks exercise the user's workflow end to end. For browser-visible
  behavior, use Playwright or another real browser runner when the project can,
  name the corresponding brief example and outcome, perform the production interaction, and assert a
  downstream scenario outcome rather than DOM presence or an intermediate side
  effect alone. Set a
  representative viewport, assert document fit or overflow, and assert that
  essential controls remain visible and reachable.

  Make browser evidence deterministic enough to falsify the implementation:
  seed or freeze randomness, begin each check from fresh scenario state, isolate
  scenarios so prior actions cannot race the next one, and
  wait for an observable stable state rather than sleeping for an arbitrary
  duration. Prefer assertions
  on the downstream state over timing or screenshot similarity alone.

Do not optimize for the number of generated tests. For every consequential
assertion, name the plausible implementation fault that should make it fail and
prefer an executed behavior over logs, source-text matching, or mere import
success. Use the project's flip or mutation-style check when available: a suite
that remains green without the change is not evidence for the change. A failure
caused only by a missing file or export establishes dependency, not behavioral
correctness, and should stay labelled as structural evidence.

For numerical, stateful, or time-dependent rules, add boundary or property cases
that establish accepted input ranges and outcome reachability. If two paths
predict and execute the same behavior, call one shared function where practical;
otherwise add a consistency check that samples both paths and compares their
state transition under the same inputs.

Screenshots can expose clipping, overlap, hierarchy, spacing, and contradictory
visible state, but one still image cannot establish motion, interaction, or a
state transition. Pair browser observations with executable state assertions,
and capture each accepted browser criterion at the state and viewport that can
actually refute it. Derive accessibility dimensions and interaction thresholds
from the accepted project requirement or applicable standard rather than from
an aesthetic guess.

When confidence is low about unfamiliar logic, search the repository, trace the
call path, run a focused experiment, or consult the applicable primary source
before choosing. Keep uncertainty visible when none of those settles it.

## Where findings go

Investigation is useful only when its findings change a checkable project
decision. Route each finding to the narrowest appropriate destination:

- **outcomes** — Clarify what must be true and how it can be observed, without
  inventing user requirements.
- **decisions** — Record the chosen approach, rationale, evidence and implications
  when the finding changes how the work will be made.
- **tests** — Add a regression, boundary, property, integration or UX check when
  the finding exposes behavior that should fail if it regresses. Associate it
  with the brief's checks and outcomes.
- **uncertainties** — Keep unresolved facts, disagreements and assumptions visible,
  with the smallest observation that would settle each question.

A receipt can support more than one destination, but a receipt is not itself a
decision, test, or proof that the implementation works. Findings that do not
change any of these should be discarded rather than padded into the record.

## Domain comparisons are conditional

Three reference products are not a default requirement. Compare products only
when a greenfield/domain question benefits from seeing distinct workflows,
invariants, interoperability choices, or UX trade-offs. One strong source,
the repository itself, a standards document, or no product comparison may be
the correct evidence elsewhere. Do not count references to make an
investigation look rigorous; record the decision-relevant difference instead.

## Boundaries with other project knowledge

This investigation is local to the current task and its uncertainty. It is a
temporary evidence trail whose useful output is routed to the current feature's
decisions, checks, or \`uncertainties\`.

\`visp learn\` records a durable project note for later recall. It is not a
research log, a citation store, or a way to make a current guess authoritative.
Promote a lesson there only when it is genuinely reusable beyond this task and
someone intentionally wants it remembered.

A generalized skill is reusable guidance that has earned a place in the
project's skill library. Do not turn one task-local investigation into a
generalized skill merely because its receipt is tidy. Generalization needs a
repeated or deliberately selected pattern, and admission remains a human
decision. This skill itself does not authorize that decision.

## Advisory status

This skill is advisory. It cannot set task scope, authorize files, change
policy, waive a gate, or claim that behavior works. Its evidence receipts
describe how a decision was investigated; they are not verification evidence.
Only the project's own runnable tests and checks, or explicitly recorded
observations under its evidence rules, can establish what happened.

When a source or check is unavailable, keep the uncertainty visible and route
it to \`uncertainties\`. A concise, honest unknown is better than a confident
imitation.
`;
