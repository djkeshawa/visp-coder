# Agent-surface golden suite

These tests pin what VISP shows coding workers, reviewers and testers, and what it decides,
for fixed scenarios. Each step's text is stored as a readable file under `__snapshots__/`:

- `<step>.txt`: a CLI call as a worker reads it (command, stdout, stderr, exit code).
- `<step>.mcp.txt`: an MCP tool call's text content, as a host's model reads it.
- `<step>.decision.json`: the decision VISP holds after the step (next action and command,
  whether the worker may edit, slice and feature status, executions, open findings, pinned
  tests and disputes).
- `<step>.<role>.prompt.txt`: the command line and prompt VISP sent to a model it launches
  (reviewer, tester, rule reader, memory gate).
- `install/<profile>/<host>.txt`: `visp install` output and every file it writes for a host.
- `hooks/...`: what the installed hook scripts answer to the inputs their hosts send.

No model runs. `support/fake-models.ts` puts stand-in `codex` and `claude` executables on
PATH that record what VISP sends and answer from a plan the scenario sets. Checks are
trivial `node` scripts. `support/normalize.ts` replaces only values that differ between
runs or machines: temporary and home paths, the Node and repository paths, timestamps,
random IDs, hashes, commit IDs, the build ID and version, and check timings.

## The rule

A changed snapshot means the change is agent-facing (kind b). A refactor or internal fix
(kind a) must leave every snapshot byte-identical. Say which snapshots changed, and why, in
the commit body.

## Running and updating

```sh
pnpm exec tsup --no-dts                  # the hooks and install embed dist/cli.js and its build ID
pnpm exec vitest run tests/golden        # check
pnpm exec vitest run tests/golden -u     # rewrite snapshots after an intended agent-facing change
```

Review the snapshot diff before committing it. A new scenario writes its files on the first
run; run the suite again to confirm it is deterministic.

Snapshot files of a step that no longer exists are not reported. When a scenario drops a
step, delete its folder under `__snapshots__/` before running with `-u`.
