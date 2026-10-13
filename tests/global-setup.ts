import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBuildId } from "../src/build/build-id.js";

const PREFIX = "visp-run-";
const STALE_MS = 2 * 60 * 60_000;

/**
 * Every test run gets its own temporary directory, removed when the run ends. Tests create
 * (and mostly remove) their own scratch directories; the ones a failure or a killed
 * subprocess left behind used to pile up in the shared /tmp, about 60 per run.
 */
export default async function setup() {
  await requireCurrentDist();
  const shared = tmpdir();
  // A run that was interrupted never reached teardown. Age keeps concurrent runs safe.
  for (const entry of await readdir(shared).catch(() => [] as string[])) {
    if (!entry.startsWith(PREFIX)) continue;
    const path = join(shared, entry);
    const details = await stat(path).catch(() => undefined);
    if (details && Date.now() - details.mtimeMs > STALE_MS)
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
  const run = await mkdtemp(join(shared, PREFIX));
  const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  for (const name of Object.keys(previous)) process.env[name] = run;
  return async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(run, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  };
}

/**
 * Tests that run the built CLI compare its build id (a hash of the sources) with the running
 * code, so a dist built from other sources fails ~220 test files with "runtime mismatch". Fail the
 * run at once with one line instead. `pnpm test` does not build; `pnpm build:fast` takes ~1 s.
 */
async function requireCurrentDist(): Promise<void> {
  const current = computeBuildId(process.cwd());
  const baked = await bakedBuildId("dist");
  if (baked === current) return;
  // Exit rather than throw: vitest would add a stack trace and a source excerpt to the one line.
  console.error(
    `dist is ${baked ? `stale (build ${baked} != sources ${current})` : "missing"}: run pnpm build:fast`,
  );
  process.exit(1);
}

/** The id tsup baked into the bundle: `var BUILD_ID = true ? "<id>" : "dev"`. */
async function bakedBuildId(dist: string): Promise<string | undefined> {
  const files = (await readdir(dist).catch(() => [] as string[])).filter((name) =>
    name.endsWith(".js"),
  );
  for (const name of files) {
    const text = await readFile(join(dist, name), "utf8").catch(() => "");
    const id = /BUILD_ID = true \? "([0-9a-f]{16})"/.exec(text)?.[1];
    if (id) return id;
  }
  return undefined;
}
