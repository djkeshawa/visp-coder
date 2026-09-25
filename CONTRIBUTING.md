# Contributing

## Setup

Use Node.js 22.16 or later and the pnpm version pinned in `package.json` (`packageManager`).

```sh
pnpm install --frozen-lockfile
pnpm build
```

## Commands

| Command | What it runs |
| --- | --- |
| `pnpm build` | Bundle `dist/` with tsup |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | Biome over `src` and `tests`; `pnpm format` applies fixes |
| `pnpm test` | The default Vitest suite (unit, integration, functional) |
| `pnpm test:unit`, `test:integration`, `test:functional` | One suite |
| `pnpm test:browser` | Real-browser journeys (`tests/browser`); set `CHROME_BIN` to choose the browser |
| `pnpm test:qualification` | Node tests for the qualification helpers |
| `pnpm test:coverage:trust` | Coverage for the trust-boundary modules |
| `pnpm test:package` | Pack and install the package into a disposable consumer |
| `pnpm check` | typecheck, lint, build and test |
| `pnpm release:check` | `check` plus browser, qualification, trust coverage and package tests |

`pnpm release:check` is the release gate and runs before publishing (`prepublishOnly`).

**Rebuild before running tests.** Several tests run the compiled CLI from `dist/`, and hook and installation tests compare the build ID of the running code with the build that generated the hooks. A stale `dist/` makes them fail. Run `pnpm build` after changing `src/`.

Browser tests need an installed Chrome or Chromium; VISP never downloads one.

## Project layout

| Path | Contents |
| --- | --- |
| `src/cli/` | Commander program and one module per command group |
| `src/mcp/` | MCP server, tool definitions (`tools/`), resources and reply shaping |
| `src/workflow/product/` | The product loop: brief, work, checks, review, critic, acceptance, `pr` |
| `src/workflow/evidence/` | Capture, control and observation readers |
| `src/testing/` | Browser journey runner and helpers (exported as `visp-coder/testing`) |
| `src/config/` | `visp.yml` schema, starter template and critic defaults |
| `src/harness/` | Host installation: instructions, hooks, MCP registration, critic agents |
| `src/graph/` | Tree-sitter repository index and queries (`visp-coder/graph`) |
| `src/memory/`, `src/skills/` | Project notes and the skill lifecycle |
| `src/runner/` | `visp-runner` (`visp-coder/runner`) |
| `src/migration/` | `visp-migrate` |
| `src/core/` | Shared primitives: file transactions, state lock, exec, paths, errors |
| `tests/unit`, `tests/integration`, `tests/functional`, `tests/browser`, `tests/qualification` | Test suites |
| `tests/fixtures/` | Briefs, replies, comparison scenarios and legacy history used by tests |
| `scripts/` | Package smoke test, upgrade qualification and review-calibration preparation |
| `bench/` | Benchmark tasks, hidden checks and runners comparing VISP with other workflows ([bench/README.md](bench/README.md)) |

CLI and MCP are thin adapters: decisions and data shapes live in `src/workflow/product/`, so a behavior change normally belongs there with tests for both surfaces.

## Documentation

User documentation lives in `README.md` and `docs/`; record user-visible changes in `CHANGELOG.md` under Unreleased, and new measurements in `docs/research-summary.md`. `tests/unit/harness/documented-workflow.test.ts` parses the browser-journey check in `README.md` and `docs/product-review.md` and the review response example in `docs/product-review.md`; keep them valid when editing.
