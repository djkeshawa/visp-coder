import { EXIT } from "./constants.js";

/**
 * Error codes are part of the machine contract: they appear in `--json` output
 * and callers branch on them.
 */
export const ERROR_CODES = [
  "NOT_INITIALIZED",
  "ALREADY_INITIALIZED",
  "CONFIG_INVALID",
  "ARTIFACT_MISSING",
  "ARTIFACT_INVALID",
  "STAGE_BLOCKED",
  "MIGRATION_REQUIRED",
  "RUNTIME_MISMATCH",
  "WORKFLOW_REPLACED",
  "STATE_BUSY",
  "SCOPE_VIOLATION",
  "EVIDENCE_MISSING",
  "EVIDENCE_FAILED",
  "NO_ACTIVE_FEATURE",
  "NO_ACTIVE_TASK",
  "TASK_NOT_FOUND",
  "GRAPH_MISSING",
  "GRAPH_STALE",
  "COMMAND_FAILED",
  "UNSUPPORTED",
  "IO_ERROR",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface VispError {
  readonly code: ErrorCode;
  readonly message: string;
  /** The exact command that would resolve this, when one exists. */
  readonly recovery?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function vispError(
  code: ErrorCode,
  message: string,
  options: { recovery?: string; details?: Record<string, unknown> } = {},
): VispError {
  return {
    code,
    message,
    ...(options.recovery ? { recovery: options.recovery } : {}),
    ...(options.details ? { details: options.details } : {}),
  };
}

const EXIT_BY_CODE: Partial<Record<ErrorCode, number>> = {
  NOT_INITIALIZED: EXIT.missingState,
  ARTIFACT_MISSING: EXIT.missingState,
  NO_ACTIVE_FEATURE: EXIT.missingState,
  NO_ACTIVE_TASK: EXIT.missingState,
  TASK_NOT_FOUND: EXIT.missingState,
  GRAPH_MISSING: EXIT.missingState,
  CONFIG_INVALID: EXIT.usage,
  UNSUPPORTED: EXIT.usage,
  INTERNAL: EXIT.internal,
  IO_ERROR: EXIT.internal,
};

export function exitCodeFor(error: VispError): number {
  return EXIT_BY_CODE[error.code] ?? EXIT.refused;
}

/** Normalizes an unknown thrown value into a VispError. */
export function fromUnknown(cause: unknown, code: ErrorCode = "INTERNAL"): VispError {
  if (cause instanceof Error) {
    return vispError(code, cause.message, { details: { name: cause.name } });
  }
  return vispError(code, String(cause));
}

export function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}
