import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "visp-run-";
const STALE_MS = 2 * 60 * 60_000;

/**
 * Every test run gets its own temporary directory, removed when the run ends. Tests create
 * (and mostly remove) their own scratch directories; the ones a failure or a killed
 * subprocess left behind used to pile up in the shared /tmp, about 60 per run.
 */
export default async function setup() {
  await warnIfDistIsStale();
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
 * code, so a dist older than src fails them with "runtime mismatch". `pnpm test` does not build.
 */
async function warnIfDistIsStale(): Promise<void> {
  const built = await stat("dist/cli.js").then(
    (details) => details.mtimeMs,
    () => undefined,
  );
  if (built === undefined) {
    console.warn("dist/cli.js is missing: run `pnpm build` before tests that execute the CLI.");
    return;
  }
  const sources = await readdir("src", { recursive: true }).catch(() => [] as string[]);
  for (const name of sources) {
    if (!name.endsWith(".ts")) continue;
    const changed = await stat(join("src", name)).then(
      (details) => details.mtimeMs,
      () => 0,
    );
    if (changed > built) {
      console.warn(
        `dist/cli.js is older than src/${name}: run \`pnpm build\` first, or CLI-based tests fail with "runtime mismatch".`,
      );
      return;
    }
  }
}
