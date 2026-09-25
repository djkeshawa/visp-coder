import { now } from "../../../../src/workflow/artifacts/common.js";
import type { ImplementMarker } from "../../../../src/workflow/artifacts/evidence.js";
import type { TestWorkspace } from "../../support/workspace.js";

/**
 * Grants a task write access, the way `gate implement` would.
 *
 * Going through the gate would drag its whole precondition chain — spec, plan,
 * context freshness — into tests that are about what the CLI does with an
 * authorization, not about how one is earned.
 */
export async function authorize(
  workspace: TestWorkspace,
  marker: Partial<ImplementMarker> & Pick<ImplementMarker, "feature" | "task">,
): Promise<void> {
  const state = await workspace.state();
  const written = await state.store.writeImplementMarker({
    kind: "implement-marker",
    createdAt: now(),
    allowedFiles: ["src/**/*.ts"],
    expectedFiles: [],
    forbiddenFiles: [],
    ...marker,
  });
  if (!written.ok) throw new Error(written.error.message);
}
