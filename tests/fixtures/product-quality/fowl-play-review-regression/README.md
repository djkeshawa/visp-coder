# Frozen Fowl Play regression

The four product/test files are byte-for-byte copies from the 2026-09-12 evaluation. Their hashes are in `provenance.json`. The local `package.json` preserves the original CommonJS loading environment. The evaluation project is never modified.

Run `node --test tests/game-core.test.mjs`: its eight original tests pass, including a test named “opposite the pull direction” whose expected vertical direction is reversed along with the implementation.

Run `node counterchecks.cjs` for independent counterexamples: down-left pull launches down; supports have visible gaps; a direct hit removes every target without additional contacts; resizing a won round resurrects targets while retaining the score and win flag. A horizontal-launch and replay control also run successfully. The combo is a recorded design shortcut to assess against the requested gameplay, not a universal prohibition on area damage.

The counterchecks execute the original core and browser controller in an instrumented VM. Only a test-visible export is appended inside its closure; DOM and animation scheduling are replaced with deterministic test adapters. These checks establish state and geometry, not browser rendering or aesthetic quality. The separate browser calibration capture script uses the original files in an isolated browser.

This is a public regression fixture, not a held-out quality evaluation. Control images are narrowly repaired references for the specified initial and launch states, not evidence that the entire game is correct or polished.
