// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const FAILURE = /\b(?:not ok|fail(?:ed|ure|ing)?|error|assert(?:ion)?(?:error)?)\b|✖|×/i;
/** Summary lines that name a failure count of zero, such as `ℹ fail 0` or `0 failed`. */
const ZERO_FAILURES = /\bfail(?:ed|ures?)?\s*[:=]?\s*0\b|\b0\s+fail(?:ed|ures?)?\b/i;
const PASS_COUNT = /\bpass(?:ed|es)?\s*[:=]?\s*\d+\b|\b\d+\s+pass(?:ed|ing)?\b/i;
const TEST_COUNT = /\btests?\s*[:=]?\s*\d+\b|\b\d+\s+tests?\b/i;
/** Status glyphs test runners print before summary lines. */
const LEADING_GLYPHS = /^[ℹ✔✖✓✗×▶►•#>*-]+\s*/u;
const HEADLINE_LENGTH = 200;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * The one line a person needs to recognise a run. For a failure, the first line
 * that reads like one; for a pass, the test runner's pass count when it prints
 * one; otherwise the last thing the command printed.
 */
export function outputHeadline(
  output: string,
  status: "passed" | "failed" | "environment-failed",
): string {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const summary = (pattern: RegExp) =>
    lines.find((entry) => pattern.test(entry) && !FAILURE.test(entry));
  const found =
    (status === "passed"
      ? (summary(PASS_COUNT) ?? summary(TEST_COUNT))
      : lines.find((entry) => FAILURE.test(entry) && !ZERO_FAILURES.test(entry))) ??
    lines.at(-1) ??
    "";
  const line = found.replace(LEADING_GLYPHS, "") || found;
  return line.length > HEADLINE_LENGTH ? `${line.slice(0, HEADLINE_LENGTH - 1)}…` : line;
}
