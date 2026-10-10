/**
 * Recovery follows the observed failure, before any generic host advice is attached.
 * A behavior failure is the product failing (an app exception can say "request timed out"),
 * so it gets no environment or check-authoring advice.
 */
export function browserFailureRecovery(
  message: string,
  url: string,
  kind?: string,
): string | undefined {
  if (kind === "behavior") return undefined;
  if (
    /net::ERR_(?:CONNECTION_REFUSED|CONNECTION_TIMED_OUT|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_CLOSED)/.test(
      message,
    )
  )
    return `app-unreachable: Start or restart the app at ${url}, confirm it responds, then rerun the same journey.`;
  if (/browser disconnected/i.test(message))
    return "browser-disconnected: The browser closed while the journey ran. Rerun the same journey once. If it disconnects again at the same step, the page is probably crashing the browser (a runaway loop or memory use); that is a product failure to fix.";
  if (/timed out|exceeded 60 seconds/i.test(message))
    return "check-authoring: Inspect the journey's selectors, expected states and wait budgets; correct the check or its timeout before rerunning. A timeout alone does not establish a product assertion failure.";
  return undefined;
}

export function executionRecovery(evidence: readonly string[]) {
  const app = evidence.find((entry) => entry.includes("app-unreachable:"));
  if (app) return app.slice(app.indexOf("app-unreachable:")).split("\n")[0];
  const disconnected = evidence.find((entry) => entry.includes("browser-disconnected:"));
  if (disconnected)
    return disconnected.slice(disconnected.indexOf("browser-disconnected:")).split("\n")[0];
  if (evidence.some((entry) => /check-authoring:|VISP: check timed out/.test(entry)))
    return "Inspect the stalled check or journey and its timeout budget before retrying; increase timeoutMs or correct its waits when appropriate.";
  return undefined;
}
