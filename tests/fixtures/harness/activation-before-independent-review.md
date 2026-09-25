<!-- visp:instructions:start -->
Follow the VISP project instructions in [AGENTS.visp.md](AGENTS.visp.md). The package is visp-coder; the executable is `visp`.

| When | Command | Next |
|---|---|---|
| Start or resume | `visp next` | Follow the returned action; unresolved is not complete. |
| New request | `visp feature "<goal>" --source-brief "<original request>"` | Read brief --template; preserve the request. |
| Plan or revise a decision | `visp brief --template` | Submit through --from -; keep the first slice to one usable behavior. |
| Implement a slice | `visp work --task <id>` | Read relevant outcomes/code, then edit only the authorized scope. |
| Refresh selected implementation context | `visp context <id>` | Compatibility delegate to work, including authorization; use query for read-only graph questions. |
| An ownership/caller/test question | `visp query search "<symbol or behavior>"` | Use callers, testsFor or impact with the returned entity; inspect source. |
| Observe a browser interaction | `visp capture --task <id> --from -` | Inspect actual images and operations; reuse applicable evidence. |
| Scheduled design or product review | `visp critic --phase understanding --preflight` | Setup-needed means inspect capabilities; ready means prepare/delegate/submit, or dispatch through an attached adapter. |
| Host review requested by next or critic is off | `visp review --task <id> --prepare` | Read packetPath and images; submit judgments with --session <id> --from -. |
| The slice is usable | `visp done --task <id>` | Follow its returned fix/critic/accept action; no duplicate worker approval. |

Research relevant uncertainties with host tools; apply conclusions in the brief. Read [VISP.commands.md](VISP.commands.md) for input examples, critic dispatch and recovery. No custom skill is needed. Reviewer configuration is not proof of invocation or quality.
<!-- visp:instructions:end -->