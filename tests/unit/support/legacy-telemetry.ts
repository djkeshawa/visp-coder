import { ok, type Result } from "../../../src/core/result.js";
import { mutateTelemetry } from "../../../src/telemetry/journal.js";
import type { Attempt, CheckEvent } from "../../../src/telemetry/store.js";
import type { WorkspaceState } from "../../../src/workflow/state.js";

/**
 * Historical journal writers. The product loop no longer records check or
 * attempt events, but journals written by earlier releases still contain them
 * and `visp report` still reads them.
 */
export async function recordLegacyCheck(
  state: WorkspaceState,
  event: Omit<CheckEvent, "attempt" | "at">,
): Promise<Result<void>> {
  if (!state.config.telemetry.enabled) return ok(undefined);
  return mutateTelemetry(state, (current) => {
    const attempt =
      current.checks.filter(
        (existing) =>
          existing.feature === event.feature &&
          existing.task === event.task &&
          existing.stage === event.stage,
      ).length + 1;
    return ok({
      event: { type: "check", value: { ...event, attempt, at: new Date().toISOString() } },
      value: undefined,
    });
  });
}

export async function recordLegacyAttempt(
  state: WorkspaceState,
  attempt: Omit<Attempt, "at">,
): Promise<Result<void>> {
  if (!state.config.telemetry.enabled) return ok(undefined);
  return mutateTelemetry(state, () =>
    ok({
      event: { type: "attempt", value: { ...attempt, at: new Date().toISOString() } },
      value: undefined,
    }),
  );
}
