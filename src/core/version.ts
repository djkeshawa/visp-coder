import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Replaced at build time by tsup with the version in package.json. Reading it
 * from a constant kept in step by hand meant `visp --version` could disagree
 * with what was published, and the CI workflow visp generates pins itself by
 * this value — so a wrong answer here installs the wrong tool.
 */
declare const __VISP_VERSION__: string | undefined;
declare const __VISP_BUILD_ID__: string | undefined;

export const VERSION = typeof __VISP_VERSION__ === "string" ? __VISP_VERSION__ : "0.0.0-dev";
export const BUILD_ID = typeof __VISP_BUILD_ID__ === "string" ? __VISP_BUILD_ID__ : "dev";

export interface RuntimeIdentity {
  readonly version: string;
  readonly buildId: string;
  readonly executable: string;
}

export function runtimeIdentity(entry: string | undefined = process.argv[1]): RuntimeIdentity {
  return {
    version: VERSION,
    buildId: BUILD_ID,
    executable: executablePath(entry),
  };
}

function executablePath(entry: string | undefined): string {
  if (!entry) return "unknown";
  try {
    return realpathSync(entry);
  } catch {
    return resolve(entry);
  }
}

/**
 * What a generated CI workflow pins to: stable patches may differ, behaviour
 * may not. Prereleases must stay exact because npm's ordinary `major.minor`
 * ranges do not select prerelease builds.
 */
export function pinnedRange(version: string = VERSION): string {
  const stable = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  return stable ? `${stable[1]}.${stable[2]}` : version;
}
