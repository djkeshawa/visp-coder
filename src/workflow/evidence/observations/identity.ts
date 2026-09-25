import type { ObservationReceipt } from "../../artifacts/observations.js";
import type { RecordObservationOptions } from "../observations.js";

/** Read legacy hashes with their original normalization; new captures preserve semantic case. */
export function observationReproductionState(
  observation: Pick<
    RecordObservationOptions | ObservationReceipt,
    "source" | "route" | "steps" | "viewport" | "capture" | "environment"
  > &
    Partial<Pick<ObservationReceipt, "kind" | "identityVersion">>,
): object {
  const insensitive = (value: string | undefined): string =>
    (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const legacy = observation.kind === "observation" && observation.identityVersion === undefined;
  return {
    source: observation.source,
    route: legacy ? insensitive(observation.route) : (observation.route ?? "").trim(),
    steps: (legacy
      ? (observation.steps ?? [])
      : (observation.steps ?? []).filter((step) => step.trim().length > 0)
    ).map((step) => (legacy ? insensitive(step) : step)),
    viewport: observation.viewport,
    capture: observation.source === "browser" ? (observation.capture ?? "viewport") : undefined,
    environment: observation.environment
      ? {
          browserEngine: insensitive(observation.environment.browserEngine),
          platform: insensitive(observation.environment.platform),
        }
      : undefined,
  };
}
