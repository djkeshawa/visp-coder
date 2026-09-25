import { vispError } from "../../core/errors.js";
import { err, ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { checksFor, type ProductBrief, type ProductSlice } from "./model.js";
import { type ProductSelection, readProductBrief } from "./store.js";

/** Examples are editable input, never predeclared coverage or executed evidence. */
export async function productCheckTemplate(
  workspace: WorkspaceState,
  kind: string,
  selection: ProductSelection = {},
) {
  if (kind !== "command" && kind !== "browser")
    return err(vispError("ARTIFACT_INVALID", "check-template must be command or browser"));
  const brief = await readProductBrief(workspace, selection);
  if (!brief.ok) return brief;
  return ok({
    example: {
      command:
        kind === "command"
          ? ["node", "--test", "tests/behavior.test.mjs"]
          : {
              kind: "browser-journey",
              journey: {
                url: "http://127.0.0.1:3000/",
                actions: [
                  { kind: "scroll", selector: "#submit" },
                  { kind: "click", selector: "#submit" },
                  { kind: "wait-for", selector: "#result", text: "Saved", capture: true },
                ],
              },
            },
      outcomes: [],
    },
    outcomes: brief.value.outcomes.map(({ id, statement }) => ({ id, statement })),
    guidance:
      "Adapt the example to the actual executable or UI and add it to the brief's checks. Link only outcomes it exercises, then reference its ID from the relevant slice. VISP allocates omitted IDs. Descriptions of manual checks belong in examples, not executable commands. Empty outcome links are allowed for exploratory checks but provide no declared outcome coverage. Nothing here has run.",
  });
}

/** Missing links are useful feedback, not a new restriction on exploratory checks. */
export function productCheckGuidance(brief: ProductBrief, slice?: ProductSlice) {
  const unlinked = checksFor(brief, slice).filter((check) => check.outcomes.length === 0);
  if (!unlinked.length) return undefined;
  return {
    advisory: true,
    unlinkedChecks: unlinked.slice(0, 3).map((check) => check.id),
    omitted: Math.max(0, unlinked.length - 3),
    guidance:
      "These checks have no outcome links. They may run successfully while outcomes remain unassessed. Link the outcomes they actually exercise in the existing brief, or leave them exploratory; do not infer coverage from a passing exit code.",
    examples: `visp brief --feature ${brief.feature} --check-template ${unlinked.some((check) => typeof check.command === "object" && !Array.isArray(check.command) && "kind" in check.command) ? "browser" : "command"}`,
  };
}
