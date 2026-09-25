# visp

This project uses `visp`. Run `visp next` — it prints the one command to run now. When in doubt, run it.

Loop: `visp feature "<goal>"` → `visp research` → `visp spec` → `visp plan` → `visp tasks` (each: seed, fill in under `.visp/features/<id>/`, validate) → `visp index` → `visp context <task>` → `visp gate implement --task <id>` → edit → `visp done` → `visp pr`.

Rules:
- Scope comes from the task graph, not the conversation. Writes outside a task's `allowedFiles` are refused; change the task, never work around a refusal.
- A validation command must be runnable (`pnpm test`), never prose like "make sure tests pass".
- Failed setup/gate: stop, not a warning. Never use || true or keep editing; recover or report the blocker.
- Before a final answer, run `visp next`; follow remaining work or report the blocker. Never claim completion before `visp done` closes the task.
- Answer structural questions with `visp query <callers | callees | testsFor | impact | search> <target>` before grepping — the index answers from parsed structure.

Every command accepts `--json`. `visp.yml` is settings (ask before changing); `.visp/` is generated state (read freely, let commands write it).
