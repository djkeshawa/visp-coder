Original request: “Build a small siege-catapult game that runs in a web browser: the player launches different kinds of projectiles from a catapult to destroy an enemy's structures, in the spirit of Angry Birds.

Contract (follow it exactly; it will be tested in a real browser, and people will also play it):

- Plain HTML, CSS and JavaScript with no build step and no dependencies: `index.html` in the project root opens the game when the directory is served over HTTP. Load nothing from the network (no CDNs, fonts or images from other hosts); draw everything yourself (canvas or DOM).
- The world is 1200 × 600 units, origin top-left, `y` increasing downward, with flat ground at `y = 560`. The game fits the browser window without scrolling at 1280 × 800 and at a 390 × 844 phone viewport, keeping the whole world visible and its aspect ratio.
- The player's catapult stands near the left edge. The enemy's structures stand on the right side: towers and walls built from blocks of three materials — wood, stone and metal — with different hit points, and enemy targets (banners) placed on or inside them.
- Aiming: press on the catapult's loaded projectile and drag back, then release. The projectile launches in the direction opposite the pull, with speed proportional to the pull distance up to a maximum pull of 150 units. It works with mouse and touch (pointer events). While dragging, show the pull and a short dotted preview of the first part of the flight.
- Projectiles — there are four kinds, and the player chooses which one to load before each shot:
  - `stone`: a heavy ball; damages what it hits in proportion to the impact speed.
  - `bomb`: explodes 1 second after launch or on its first impact, whichever comes first, damaging every body within 80 units, more at the center than at the edge, and pushing them away from the blast.
  - `cluster`: splits into three smaller shots, spreading slightly, when the player clicks or taps during its flight (or at the top of its arc if the player does not); each fragment damages like a small stone.
  - `fire`: sets the first wooden block it touches on fire; a burning block loses hit points over 3 seconds and spreads fire to wooden blocks touching it. Fire does not harm stone or metal.
- Physics: constant downward gravity; projectiles fly ballistic arcs. Blocks and targets rest on the ground and on each other, fall when unsupported, and do not pass through the ground or each other. Impacts damage both bodies in proportion to the impact speed; a body at 0 hit points is removed. Materials: wood is weak and burns, stone is strong, metal is strongest and only a direct stone hit at full launch speed or a bomb blast can hurt it.
- Scoring: removing a wood block gives 100 points, stone 300, metal 800, and a target 2000.
- A shot ends when all projectiles and fragments have left the world or everything has come to rest (or 10 seconds after launch at most); then the catapult reloads.
- Levels: there are 3 levels, each with its own structure and its own ammunition allowance per projectile kind (for example 2 stones, 1 bomb, 1 cluster, 1 fire), shown on screen. A kind with no rounds left cannot be selected. The level is won as soon as no targets remain. It is lost when the last shot ends with targets remaining. After a win show a "Next level" button (after the last level, "Play again" returns to level 1); after a loss show a "Retry" button. A "Restart" button is always available and restarts the current level.
- Show the level, the score, the selected projectile and the rounds remaining of each kind on screen.
- State for automated tests: the element `#game` is the one that displays the world (its on-screen box is the 1200 × 600 world at the current scale) and carries `data-state` (one of `aiming`, `flying`, `won`, `lost`; `flying` lasts from launch until the shot ends), `data-level` (1–3), `data-score`, `data-ammo` (the selected kind), and `data-targets` (targets remaining), always current.
- Test hooks on `window.gameTest`, which drive exactly the same game logic as a player:
  - `pause()` stops the game's own clock; `step(ms)` then advances the simulation by `ms` milliseconds of game time in fixed steps of at most 1000/60 ms; `resume()` restarts the clock.
  - `select(kind)` selects the projectile kind for the next shot (returns `false` if none are left).
  - `launch(angleDegrees, power)` launches the loaded projectile as if pulled and released: angle 0 is straight right and 90 straight up; `power` from 0 to 1 is the fraction of the maximum pull.
  - `trigger()` performs the in-flight action (splitting a cluster); it does nothing for other kinds.
  - `restart(level)` restarts the given level (1–3) from its initial layout and ammunition.
  - `snapshot()` returns `{ state, level, score, ammo, selected, targets, projectiles, bodies }`, where `ammo` maps each kind to rounds remaining, `projectiles` lists flying projectiles and fragments as `{ kind, x, y, vx, vy }` (center, units and units per second), and `bodies` lists remaining blocks and targets as `{ kind: "block" | "target", material, x, y, hp, burning }` with the center position (`material` is `null` for targets).
- Make it look and feel like a game: readable colors, a sky and ground, visible projectile trails, a visible explosion for bombs, flames on burning blocks, and simple feedback when something is destroyed.”

Does this implementation support that request? Independently inspect the supplied states and recorded operations. Return zero to three consequential findings with supporting observations and a useful next check, or explain what you found satisfactory. State what the supplied evidence cannot establish.
