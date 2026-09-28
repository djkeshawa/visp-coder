import { vispError } from "../core/errors.js";
import type { ProjectFileSystem } from "../core/fs.js";
import type { ProjectPaths } from "../core/paths.js";
import { err } from "../core/result.js";
import { requireRuntimeAgreement } from "../core/runtime-agreement.js";
import { runtimeIdentity } from "../core/version.js";
import { readInstallState } from "./install-state.js";

/** Historical records remain readable; only an identified installation authorizes mutation. */
export async function requireInstalledRuntime(paths: ProjectPaths, files: ProjectFileSystem) {
  const installed = await readInstallState(paths, files);
  if (!installed.ok) return installed;
  if (!installed.value)
    return err(
      vispError(
        "STAGE_BLOCKED",
        "Project harness installation is required before product mutations",
        { recovery: "visp install" },
      ),
    );
  const agreed = requireRuntimeAgreement(
    installed.value.runtime,
    runtimeIdentity(),
    "installed assets",
  );
  const installedCommand = installed.value.runtime?.executable
    ? `Run node ${JSON.stringify(installed.value.runtime.executable)} or use the installed MCP tools.`
    : "Inspect the installed runtime with visp doctor.";
  return agreed.ok
    ? agreed
    : err({
        ...agreed.error,
        message: `Installed harness runtime cannot authorize this operation: ${agreed.error.message}`,
        recovery: `${installedCommand} To switch builds, run visp install --replace-runtime and restart stale MCP/host processes. Historical evidence remains unchanged.`,
      });
}
