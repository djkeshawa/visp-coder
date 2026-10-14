import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../core/exec.js";
import { resolvedProductExecutionEnvironment } from "../../core/execution-environment.js";
import { outputRedactor } from "../../core/redaction.js";
import { removeTreeBestEffort } from "../../core/stale-temp.js";
import { acceptanceEnvironment, privateTemporaryDirectory } from "./acceptance-environment.js";
import { browserUnavailable } from "./environment.js";
import { BASELINE_TIMEOUT_MS, type TestFields } from "./independent-tests-model.js";
import { NO_NAMED_FAILURE, UNDECLARED_FAILURE } from "./independent-tests-prompts.js";
import { environmentErrorLine, environmentOnly, failLineStats } from "./pinned-dispute-model.js";

const MAX_LISTED_LINES = 5;
const MAX_LISTED_CHARS = 300;

/** A suite that reports an environment error while a browser starts here is repaired. */
const BROWSER_AVAILABLE =
  "VISP's own check starts a browser here: the browser is available, so do not print ENVIRONMENT ERROR; print a FAIL line per failing test.";

export async function baselineRejection(
  baseline: Awaited<ReturnType<typeof runBaseline>>,
  existing: Awaited<ReturnType<typeof runBaseline>> | undefined,
  declared: readonly string[],
  redact: (text: string) => string,
  root: string,
): Promise<Pick<TestFields, "status" | "reason"> | undefined> {
  const failure = runFailure(baseline, existing);
  if (failure) return { status: "rejected", reason: failure };
  // A suite that says only "environment error" tells nothing about the product, but a suite
  // can print that line to dodge attribution, so VISP checks the browser itself.
  const environment = environmentOnly(baseline.fullOutput, declared)
    ? environmentErrorLine(baseline.fullOutput)
    : undefined;
  if (environment !== undefined && (await browserUnavailable(root)))
    return {
      status: "failed",
      reason: `The suite could not run in this environment (${redact(environment).slice(0, MAX_LISTED_CHARS)}) and VISP's own check finds no browser that starts here, so no product behavior was tested and no tests were pinned. Run the tester again where a browser is available.`,
    };
  const reason = attributionRejection(baseline.fullOutput, baseline.output, declared, redact);
  return reason
    ? {
        status: "rejected",
        reason: environment === undefined ? reason : `${reason} ${BROWSER_AVAILABLE}`,
      }
    : undefined;
}

function runFailure(
  baseline: Awaited<ReturnType<typeof runBaseline>>,
  existing: Awaited<ReturnType<typeof runBaseline>> | undefined,
): string | undefined {
  if (existing && (existing.exitCode !== 0 || existing.timedOut || existing.spawnFailed))
    return `Tests of existing behavior fail on the launch-time repository copy, so the suite assumes something the code does not do: ${existing.output.slice(-600)}`;
  if (baseline.spawnFailed || [127, 9009].includes(baseline.exitCode))
    return "The test interpreter could not start; no product behavior was tested";
  if (baseline.timedOut) return "The tests did not finish on the unimplemented project";
  if (baseline.exitCode === 0)
    return "The tests pass before any implementation, so they check nothing new";
  return undefined;
}

/**
 * A later failure must be attributable to a test the reviewer can rule on: a crash before
 * any test ran, or FAIL lines with other names, would pin a suite nobody can dispute.
 */
function attributionRejection(
  full: string,
  tail: string,
  declared: readonly string[],
  redact: (text: string) => string,
): string | undefined {
  if (!declared.length) return undefined;
  const stats = failLineStats(full, declared);
  if (!stats.named.length)
    return `${NO_NAMED_FAILURE}, so a later failure cannot be attributed to a test or disputed (a crash, an import or syntax error, or FAIL lines with other names). Declared names: ${declared
      .slice(0, 12)
      .map((name) => JSON.stringify(name))
      .join(", ")}. Output tail: ${tail.slice(-600)}`;
  if (stats.undeclared.length)
    return `${UNDECLARED_FAILURE} (${stats.undeclared
      .slice(0, MAX_LISTED_LINES)
      .map((line) => JSON.stringify(redact(line).slice(0, MAX_LISTED_CHARS)))
      .join(", ")}). Every FAIL line must be \`FAIL: <exact name from tests[].name>: <reason>\`.`;
  return undefined;
}

export function testCommand(path: string): string[] {
  return path.endsWith(".py")
    ? [process.platform === "win32" ? "python" : "python3", path]
    : ["node", path];
}

/**
 * One run of the pinned or candidate tests, in its own process group that is ended
 * afterwards: suites start servers, and one left two running after it finished.
 */
export async function runBaseline(
  root: string,
  command: string[],
  extra: Record<string, string> = {},
  options: { signal?: AbortSignal; timeoutMs?: number; redact?: (text: string) => string } = {},
) {
  const [file, ...args] = command as [string, ...string[]];
  const redact = options.redact ?? (await outputRedactor(root));
  const env = await resolvedProductExecutionEnvironment();
  // Its own HOME and temporary directory, as a pinned check gets: two baselines that run
  // together share no browser profile lock.
  const home = await mkdtemp(join(tmpdir(), "visp-baseline-"));
  let result: Awaited<ReturnType<typeof run>>;
  try {
    await mkdir(privateTemporaryDirectory(home), { recursive: true, mode: 0o700 });
    result = await run(file, args, {
      cwd: root,
      env: { ...acceptanceEnvironment(env, home), VISP_ACCEPTANCE_BASELINE: "1", ...extra },
      replaceEnv: true,
      timeoutMs: options.timeoutMs ?? BASELINE_TIMEOUT_MS,
      signal: options.signal,
    });
  } finally {
    await removeTreeBestEffort(home);
  }
  if (!result.ok) {
    const output = redact(result.error.message);
    return { exitCode: -1, timedOut: false, spawnFailed: true, output, fullOutput: output };
  }
  const full = `${result.value.stdout}\n${result.value.stderr}`.trim();
  return {
    exitCode: result.value.exitCode,
    timedOut: result.value.timedOut,
    spawnFailed: false,
    output: redact(full).slice(-2000),
    // Unredacted so declared test names match what the suite printed; only used to attribute
    // FAIL lines in memory, never stored or shown (`output` above is what a record keeps).
    fullOutput: full.slice(-200_000),
  };
}
