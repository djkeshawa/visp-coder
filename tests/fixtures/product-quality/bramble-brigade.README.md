# Bramble Brigade regression fixture

`bramble-brigade.html` is an unchanged byte-for-byte copy of a game a coding
agent built under VISP in an evaluation run, frozen on 2026-09-08.

SHA-256: `8b06e6427c2a8f3234724c2c47c46923d58ae43d41d638b9f5bb0b8eb86b1e31`

This fixture intentionally retains observed product failures: reversed vertical
pull, Arrow then Space leaving aim stuck, interception of the restart button's
centre, clipped initial mobile composition, and a bird that stays at the sling
while the held band moves. The browser regressions pass when they detect these
failures through native input, public DOM state, and rendered canvas pixels.
They do not modify game state, replace physics, synthesize DOM input events, or
infer overall visual quality from a screenshot hash. A limited countercheck
clicks the exposed restart edge and observes that the same control can reset.

The tests use the repository's installed Chrome adapter with its normal sandbox
and isolated temporary profile. Each browser case has a 30-second limit. Keep
the fixture bytes and hash unchanged; add a separate fixture for future variants.
