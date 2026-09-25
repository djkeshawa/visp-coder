# Frozen Feather & Fury counterexample

Actual game sources from the 9 September 2026 evaluation, preserved without fixes. The manifest retains hashes from that audit; only the runtime JavaScript is needed by these Node counterchecks. The original five primitive tests are retained as `game-core.test.fixture` for inspection, not collected as VISP tests.

`counterchecks.cjs` executes the actual functions with stubbed DOM and scheduling. It reproduces reversed vertical aiming, a zero-velocity second keyboard shot, a stale victory timer after Reset, ignored repeat block contact, and launching on pointer cancellation. It also verifies correct diagonal reflection and ordinary level advance. Synthetic setup isolates the collision/timer defects; this is not a live-browser or solvability test.

The shared browser adapter is tested on independently authored small pages for layout, score comparison, and native touch cancellation.
