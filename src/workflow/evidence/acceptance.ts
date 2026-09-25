import { vispError } from "../../core/errors.js";
import { resolveCommand } from "../../core/exec.js";
import { sha256 } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { AcceptanceBaseline } from "../artifacts/acceptance.js";
import type { WorkspaceState } from "../state.js";

/** Pin external expectations before implementation; this is change detection, not author authentication. */
export async function captureAcceptanceBaseline(
  state: WorkspaceState,
): Promise<Result<AcceptanceBaseline>> {
  const baseline: AcceptanceBaseline = [];
  for (const check of state.config.workflow.acceptanceChecks) {
    const command = resolveCommand(check.command);
    if (!command.ok) return err(vispError("CONFIG_INVALID", command.error.message));
    const files: Array<AcceptanceBaseline[number]["files"][number]> = [];
    for (const path of check.files) {
      const content = await state.files.readBytes(path);
      if (!content.ok)
        return err(
          vispError(
            "CONFIG_INVALID",
            `Cannot pin acceptance file ${path}: ${content.error.message}`,
            {
              recovery:
                "Provide the acceptance tests and their helpers before starting the feature",
            },
          ),
        );
      files.push({ path, sha256: sha256(content.value) });
    }
    const [first, ...remaining] = files;
    if (!first)
      return err(vispError("CONFIG_INVALID", "Acceptance checks must pin at least one file"));
    baseline.push({ command: check.command, files: [first, ...remaining] });
  }
  return ok(baseline);
}
