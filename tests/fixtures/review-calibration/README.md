# Review calibration fixtures

Seven scenarios, each with a defective and a control variant, a `prompt.md` (the original request the reviewer sees) and two evaluator-only oracles. Oracles, variant names and scenario names never enter a reviewer packet.

| Scenario | Images | Defect measured |
|---|---|---|
| `fowl-play`, `flockshot`, `booking`, `checkout` | rendered by `scripts/prepare-review-calibration.mjs` from patched copies of the frozen sources | release direction, unsupported structure, mirrored release, wrong summary |
| `catapult-preview` | rendered from `tests/fixtures/product-quality/catapult-preview-regression`; the control patches two lines of `game.js` | the dotted preview starts at the pulled stone while the stone launches from the sling |
| `slingshot-preview` | frozen frames in this directory (a natural pair of two independently written games) | the dashed preview does not follow the flight that comes after release |
| `catapult-finish` | frozen level 1 and level 3 frames in this directory | sparse, untextured levels and a level with no wood for the fire projectile; scored on optional findings only |

`scripts/freeze-review-calibration-fixtures.mjs <runs-dir>` regenerates the frozen frames and the catapult source copy from finished benchmark runs. It is not run in CI.

Oracle fields: `expectedDefects` (empty for controls), `expectedAdvisory`, `counterevidence`, `evaluationScope`, and for defective oracles `caughtIf`. `caughtIf` is a list of alternatives; each alternative is a list of case-insensitive regular expressions. Expressions are word-anchored; an alternative for a preview needs a preview term, a mismatch term and a launch or flight term, and a finish alternative ties a sparseness term to a content noun. A finding catches the defect when it matches every expression of one alternative, and the case is caught when any finding does, required or not.
