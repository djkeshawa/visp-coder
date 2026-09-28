/** Recovery follows the observed failure, before any generic host advice is attached. */
export function browserFailureRecovery(message: string, url: string): string | undefined {
  if (
    /net::ERR_(?:CONNECTION_REFUSED|CONNECTION_TIMED_OUT|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_CLOSED)/.test(
      message,
    )
  )
    return `app-unreachable: Start or restart the app at ${url}, confirm it responds, then rerun the same journey.`;
  if (/timed out|exceeded 60 seconds/i.test(message))
    return "check-authoring: Inspect the journey's selectors, expected states and wait budgets; correct the check or its timeout before rerunning. A timeout alone does not establish a product assertion failure.";
  return undefined;
}

export function executionRecovery(evidence: readonly string[]) {
  const app = evidence.find((entry) => entry.includes("app-unreachable:"));
  if (app) return app.slice(app.indexOf("app-unreachable:")).split("\n")[0];
  if (evidence.some((entry) => /check-authoring:|VISP: check timed out/.test(entry)))
    return "Inspect the stalled check or journey and its timeout budget before retrying; increase timeoutMs or correct its waits when appropriate.";
  return undefined;
}
