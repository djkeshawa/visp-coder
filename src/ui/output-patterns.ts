// Shared by the server-side run summaries and the browser dashboard, so it has no Node imports.

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export const FAILURE = /\b(?:not ok|fail(?:ed|ure|ing)?|error|assert(?:ion)?(?:error)?)\b|✖|×/i;
/** Summary lines that name a failure count of zero, such as `ℹ fail 0` or `0 failed`. */
export const ZERO_FAILURES = /\bfail(?:ed|ures?)?\s*[:=]?\s*0\b|\b0\s+fail(?:ed|ures?)?\b/i;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
