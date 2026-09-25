/** Uncaught application errors are product observations, not browser startup failures. */
export function applicationException(params: Record<string, unknown>): string {
  const details = params.exceptionDetails as
    | {
        text?: string;
        exception?: { description?: string };
        stackTrace?: {
          callFrames?: {
            functionName?: string;
            url?: string;
            lineNumber?: number;
            columnNumber?: number;
          }[];
        };
      }
    | undefined;
  const description =
    details?.exception?.description ?? details?.text ?? "Uncaught JavaScript exception";
  const frames = (details?.stackTrace?.callFrames ?? [])
    .slice(0, 8)
    .map(
      (frame) =>
        `${frame.functionName || "anonymous"} (${frame.url ?? "unknown"}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1})`,
    );
  return `Application JavaScript error: ${description}\n${frames.join("\n")}`.trim().slice(0, 6000);
}
