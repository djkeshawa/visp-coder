# Working on visp-coder

For agents developing THIS repository (not product docs). Setup, commands, layout and release
steps are in [CONTRIBUTING.md](CONTRIBUTING.md); internals are in `docs/internals.md`. Read both
before changing behaviour. Work in a git worktree per topic, never on `develop` or `main`.

## Speed rules

- **Build ID.** Tests compare the build ID baked into `dist/` with a hash of `src/**`,
  `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsup.config.ts`. After ANY edit to those,
  run `pnpm build:fast` (~1 s, no `.d.ts`). A stale or missing `dist/` stops a test run at once with
  `dist is stale (build X != sources Y): run pnpm build:fast`. `build:fast` wipes `dist/ui`; run
  `pnpm exec tsup --config tsup.ui.config.ts` when a test needs the dashboard. `pnpm build` is the
  full build.
- **Inner loop.** Run only the tests that cover what you changed:
  `pnpm exec vitest run $(node scripts/direct-tests.mjs src/x.ts) --bail=1`, adding `-t "<name>"`
  and `--maxWorkers=4`. The script lists tests that import the module plus the naming map
  (`src/core/X.ts` to `tests/unit/core/X.test.ts`, `src/workflow/product/X.ts` to
  `tests/unit/workflow/evidence/product-X.test.ts`). It prints nothing and warns when there is no
  direct test: an empty list would make vitest run everything, so check before running.
- **Never `vitest related` or `--changed`.** The product barrel makes them select 170 to 330 of 429
  files.
- **Cheap gates, before every commit.** `pnpm lint` (~3 s), `pnpm knip` (~4 s), `pnpm typecheck`
  (~18 s), and the golden suite `pnpm exec vitest run tests/golden`.
- **Full suite (~10 min)** only in the background, in a separate verify worktree:
  `git worktree add ../visp-coder-verify --detach <sha>`, install, `pnpm build`, `pnpm test`. tsup
  `clean: true` wipes `dist/` under a running suite, so never build in the worktree being tested.
  One heavy run at a time.
- **Browser suite**, only when `src/testing`, capture or journey code changes:
  `env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS CHROME_BIN=/usr/bin/google-chrome pnpm test:browser`
- **Trust coverage** (`pnpm test:coverage:trust`) only for files listed in
  `vitest.trust-boundary.config.ts`; run the targeted form first (that config's tests for the
  changed module), the whole config last.

## Quality contract

VISP is judged on what agents build with it: hidden checks, a blind visual judge, a blind
code-quality judge and review quality. Speed matters only after that. Every change is one of two
kinds:

- **(a) Cannot alter what agents see or what VISP decides**: refactors, test infrastructure,
  install and doctor fixes, internal fixes. Proof: the golden suite (`tests/golden`) stays
  byte-identical.
- **(b) Agent-facing**: instructions, guides, prompts, reply content, reviewer or tester packets,
  image delivery, gating rules, hooks. Golden snapshots change, and the commit says so. It merges
  only after a paired quality batch (`bench/`, see `bench/README.md`) shows no drop on any metric.

Speed guardrail: median wall-clock and idle time per run must not get more than 15% worse unless a
measured quality gain pays for it.

## Gates and conventions

- Commit subject `type: summary` (fix, feat, test, docs, perf, refactor, chore, bench, ci). The
  body gives the why with measured evidence, then what changed. Small commits.
- Bug fixes: write the failing test first and watch it fail.
- User-visible changes get an entry under `## Unreleased` in `CHANGELOG.md` (add the heading if
  missing). Update `README.md` or `docs/` when behaviour changes, and keep
  `tests/unit/harness/documented-workflow.test.ts` passing.
- knip: delete unused code, do not ignore it. Add no import cycles (`knip --cycles`; the allowed
  ones are in `knip.json`).
- Exports are pinned in `tests/compat/current-product-api.ts`. No new dependency, changed default
  or removed public API without an owner decision.
- Git flow: topic branch, then a PR into `develop`. `develop` goes to `main` only for releases (see
  CONTRIBUTING.md). Never push tags or touch release machinery from a topic branch.
- Match the surrounding code: comment density, naming, idiom. Prose is plain, short sentences, no
  marketing.
