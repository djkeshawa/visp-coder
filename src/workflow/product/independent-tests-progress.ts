import type { WorkspaceState } from "../state.js";
import { runBaseline } from "./independent-tests-baseline.js";
import { BASELINE_TIMEOUT_MS } from "./independent-tests-model.js";
import { waivedTestsEnv } from "./pinned-dispute-model.js";
import { readProductRecord } from "./store.js";

/** What `done` reports about the pinned tests before the last slice runs them as checks. */
export interface AcceptanceProgress {
  readonly passing: boolean;
  readonly command: string;
  /** Tail of the failing run; `output` would be dropped from compact text. */
  readonly failure?: string;
  readonly note: string;
}

function progressNote(passing: boolean, timedOut: boolean): string {
  if (passing) return "Pinned acceptance tests pass.";
  return timedOut ? TIMED_OUT_NOTE : STILL_FAIL_NOTE;
}

const STILL_FAIL_NOTE =
  "Pinned acceptance tests still fail. This does not block this slice, but the last slice cannot close until they pass. Fix the product, not the tests; but never change documented existing behavior to satisfy one.";

const TIMED_OUT_NOTE =
  "Pinned acceptance tests did not finish in the time left for this command; they were cut off, not shown failing. Run visp done again for a full result. The last slice cannot close until they pass.";

/**
 * Weak workers stopped before the last slice, where pinned tests become checks, so they
 * never saw them fail. Earlier `done` calls run them for information: a failure there
 * does not block closing the slice, since later slices may still owe the behavior.
 */
export async function acceptanceProgress(
  workspace: WorkspaceState,
  feature: string,
  executedChecks: readonly string[],
  options: import("./store.js").ProductSelection = {},
): Promise<AcceptanceProgress[]> {
  if (executedChecks.some((check) => check.startsWith("PINNED_"))) return [];
  const loaded = await readProductRecord(workspace, { feature });
  if (!loaded.ok) return [];
  const results: AcceptanceProgress[] = [];
  for (const pinned of loaded.value.brief.acceptanceBaseline) {
    if (options.signal?.aborted || Date.now() >= (options.deadline ?? Infinity)) break;
    await options.onProgress?.({ check: "acceptance baseline", status: "running" });
    const command =
      typeof pinned.command === "string" ? pinned.command.split(" ") : [...pinned.command];
    const outcome = await runBaseline(
      workspace.paths.root,
      command,
      await waivedTestsEnv(workspace, feature),
      {
        signal: options.signal,
        timeoutMs: Math.max(
          1,
          Math.min(BASELINE_TIMEOUT_MS, (options.deadline ?? Infinity) - Date.now()),
        ),
      },
    );
    const passing = outcome.exitCode === 0 && !outcome.timedOut;
    results.push({
      passing,
      command: command.join(" "),
      // A run that was cut off shows nothing failing, so it carries no failure tail.
      ...(passing || outcome.timedOut ? {} : { failure: outcome.output.slice(-1200) }),
      note: progressNote(passing, outcome.timedOut),
    });
  }
  return results;
}
