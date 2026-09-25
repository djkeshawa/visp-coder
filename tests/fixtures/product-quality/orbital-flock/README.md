# Orbital Flock regression fixture

Frozen from the 2026-09-08 Luna max VISP run. This is intentionally uncorrected user-produced game source, not VISP runtime code. The original game is unchanged.

The countercheck executes actual collision, transition and quick-shot functions in a Node VM with minimal DOM stubs and deterministic timer delivery. It reproduces a diagonal reflection defect and a delayed victory callback surviving reset, while independently confirming improved top-contact normals. It does not simulate real rendering, touch usability or manual level solvability. The retained brief drives review-context tests for primary play-area hierarchy, promised pointer/touch/keyboard input and narrow-screen usability.

The audited browser run's erroneous wait expected Quick Shot to re-enable after its third shot won. A later executed observation correctly checked the victory overlay; different journeys must not silently clear each other's failures. Product-loop tests model both receipts explicitly and require a review resolution backed by current observation and image evidence.
