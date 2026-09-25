import { z } from "zod";
import { type VispError, vispError } from "./errors.js";
import { err, ok } from "./result.js";
import { type RuntimeIdentity, runtimeIdentity } from "./version.js";

export const identifiedRuntimeSchema = z
  .object({
    version: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((version) => version !== "0.0.0-dev"),
    buildId: z.string().regex(/^[a-f0-9]{16}$/),
    executable: z.string().trim().min(1).max(4096),
  })
  .strict();

/** Executable locations are diagnostic; identical builds may have different entry points. */
export function requireRuntimeAgreement(
  observed: unknown,
  expected: RuntimeIdentity = runtimeIdentity(),
) {
  const current = identifiedRuntimeSchema.safeParse(expected);
  const peer = identifiedRuntimeSchema.safeParse(observed);
  if (
    current.success &&
    peer.success &&
    current.data.version === peer.data.version &&
    current.data.buildId === peer.data.buildId
  )
    return ok(undefined);
  return err(
    vispError(
      "RUNTIME_MISMATCH",
      !current.success || !peer.success
        ? "Runtime agreement is unavailable: both processes must report an identified VISP build"
        : `VISP runtime mismatch: caller ${current.data.version} build ${current.data.buildId}, guard ${peer.data.version} build ${peer.data.buildId}`,
      {
        recovery:
          "Inspect CLI doctor and MCP visp_doctor runtime fields and the guard executable on PATH. Use the same built VISP version/build, then restart stale MCP and host processes; rerun doctor before continuing. A matching package version alone is insufficient.",
        details: {
          failure: !current.success || !peer.success ? "runtime-unidentified" : "runtime-mismatch",
          expected: current.success ? current.data : { identified: false },
          observed: peer.success ? peer.data : { identified: false },
        },
      },
    ),
  );
}

/** Diagnosis must identify its process even when a workspace cannot be loaded. */
export function withRuntimeDiagnostic(error: VispError): VispError {
  return { ...error, details: { ...error.details, runtime: runtimeIdentity() } };
}
