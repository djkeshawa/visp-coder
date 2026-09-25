import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeBuildId } from "../src/build/build-id.js";

// Source workers and built subprocesses must identify the same tested runtime inputs.
const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
export const runtimeDefines = {
  __VISP_VERSION__: JSON.stringify(version),
  __VISP_BUILD_ID__: JSON.stringify(computeBuildId(root)),
};
