# Runner

`visp-runner` is an optional executable for controlled experiments with coding agents. It runs one explicitly configured agent attempt in an isolated Git worktree, records its source and events, evaluates the result with a separately pinned oracle, and prepares matched comparisons. The ordinary `visp` CLI and MCP server never call models and do not import the runner. The library is available as `visp-coder/runner`.

The runner never picks a model, a price or a budget for you, and preparing a study never launches a model.

## Hosts

| | Codex | Claude Code |
| --- | --- | --- |
| Execution | `exec --json` | `--print --output-format stream-json --verbose` |
| Model and executable pin | Yes | Yes |
| Resume | Named session in the same worktree | Named session in the same worktree |
| Dollar limit | Estimated from a supplied price snapshot | Host estimate plus `--max-budget-usd` |
| Tool observation | Completed MCP calls | Tool calls correlated with successful results |
| Command observation | Completed `command_execution` with exit 0 | Successful `Bash` calls |

`visp-runner capabilities` prints the enforced controls and what each host can observe. A requested host sandbox is not independently verified, and dollar limits are estimates, not billing caps. Execution is supported on POSIX systems.

Only a small environment allowlist reaches the host process; API-key variables are not inherited. CLI credentials under the home directory can still be read, so this local mode assumes a trusted machine and repository.

## Running an attempt

Write a JSON `RunnerSpec` (exported as `runnerSpecSchema`). Required parts:

- `schemaVersion: 1`, a unique `id`, an absolute `repository` and an existing commit `revision`;
- `task` (`feature`, `task`) and the complete `prompt`;
- `host`: `kind` (`codex` or `claude`), absolute `executable`, its SHA-256, exact `--version` output, `model`, optional `effort`;
- `permissions`: `mode` (`read-only` or `workspace-write`), `requireSandbox: false`, optional `allowedTools` (Claude only);
- `budget`: `maxDurationMs`, `maxEstimatedUsd`, `studyMaxEstimatedUsd`, `studyApprovalId`, `monetaryEnforcement: "estimated"`, and a `prices` snapshot;
- `harness`: `mode`, pinned `files` with hashes, `requiredTools`, `requiredHooks`, optional exact `requiredCommands` argument vectors;
- `assignment`: `study`, `scenario`, `repositoryGroup`, `arm` (`economical-baseline`, `economical-visp`, `strong-reference` or `ablation`), `split`, `repetition`, `order`.

```sh
visp-runner run --spec run.json --output runs/
visp-runner inspect runs/<run-id>
visp-runner run --spec resume.json --output runs/ --resume-from runs/<run-id>
```

The output directory must be outside the candidate repository. Each attempt gets a detached worktree, a hash-chained event log, source snapshots and `result.json`; `inspect` verifies them. SIGINT and SIGTERM stop the host's process group and record an unsuccessful attempt.

Before the first model turn the runner reserves the attempt's full `maxEstimatedUsd` against the study in a ledger under `.visp-runner/studies/<study>` in the output root. Reservations are never refunded, and a study's approval ID and ceiling cannot change after its first reservation.

Required tools and commands are evidence requirements: an unobserved requirement makes the attempt unsuccessful. Only successful, correlated tool results count; command observations accept plain commands and must match the declared argument vector exactly.

## Actor and reviewer turns

Adding `feedbackLoop` to a runner spec makes the runner alternate actor and reviewer turns within the same total allowance:

```json
{
  "feedbackLoop": {
    "maxRounds": 3,
    "actorMaxDurationMs": 120000,
    "reviewMaxDurationMs": 60000,
    "criteria": [
      {"id": "repeat", "expectation": "A second real input after the first settles produces the promised result."}
    ]
  }
}
```

The runner waits for the actor's processes to exit, snapshots the candidate and starts a fresh reviewer session with read-only permissions. The reviewer returns one observation per criterion and at most three findings, with a decision of `pass`, `repair`, `evidence` or `unavailable`. A pass needs evidence for every criterion; a repair names the failure and its next check; the next review must replay a previously failed exercise. Source changes during review, stale or invalid reviews and timeouts stop the loop. Each phase receives at most half of the remaining cost allowance.

## Independent evaluation

The evaluator runs a trusted oracle in a Docker-compatible engine against a finished run, with the image pinned by digest, network disabled and the candidate mounted read-only.

```sh
visp-runner hash-policy oracle/
visp-runner evaluate --run runs/<run-id> --spec evaluator.json
visp-runner inspect-evaluation runs/<run-id> <evaluation-id>
```

An `EvaluatorSpec` names the image, engine, `policyDirectory` and `policyHash`, the `command` (inside `/evaluator/`), the report `format` (`vitest`, `pytest` or `playwright`), `reportFile`, `requiredTests`, a non-root `uid`/`gid` and `timeoutMs`. Every required test must pass; skipped, flaky or missing tests, timeouts and nonzero exits are not accepted. A local `accepted` result is not an attested CI identity.

## Comparisons

`prepare-comparison` pins a small quality comparison: three tasks × three arms (`bare`, `frozen-legacy`, `replacement`) × three repetitions, with identical host, model, tools, instructions and starting trees. It copies and hashes every input and writes a manifest with `runnable: false` and `budget: null`.

```sh
visp-runner prepare-comparison --spec comparison.json --output prepared/
visp-runner summarize-comparison --prepared prepared/ --observations observations.json
```

The spec follows `comparisonSpecSchema`. Starter scenarios live in `tests/fixtures/comparison` (`pagination`, `reservations`, `booking-ui`, `missile-building`); they are public fixtures, so use private held-out scenarios for a real study. Never mount the prepared directory into a candidate workspace: it contains the oracles.

`summarize-comparison` keeps quality dimensions separate (correctness and brief fidelity as fractions, usability and visual quality on 0–4 rubrics, severe defects as counts) and reports time, cost, tokens, review cycles and administrative repairs as secondary measures. Failed and missing runs stay in the denominators. Observations may add `capabilitySignals` (whether graph, memory or skills changed a decision) and `loop` (first-pass versus repaired correctness).

Related preparation commands:

- `prepare-critic-comparison --comparison prepared/ --config critic-models.json` adds a critic ablation (no critic, same-model critic, stronger-model critic), or a staged `feedback-policy` study.
- `prepare-review-calibration --comparison prepared/ --spec calibration/spec.json` pins reviewer calibration on defective and correct variants of fixed cases. `node scripts/prepare-review-calibration.mjs <inputs-dir> <reviewer.json>` generates its images first.
- `pilot` and `summarize` read studies prepared under the older cost-first policy; `escalation <inputFile>` gives a deterministic next-step recommendation for a failed attempt.

None of these commands promote anything automatically or produce a confidence claim; small pilots can find regressions but not establish general superiority.
