/** Preserve named reporter outcomes that a bounded log tail would otherwise hide. */
export function earlierAssertionResults(
  text: string,
  tailBudget: number,
  limit = 2000,
  failLinesSupplied = false,
) {
  if (text.length <= tailBudget) return "";
  const cut = text.length - tailBudget;
  const boundary = text.indexOf("\n", cut);
  const end = boundary < 0 ? cut : boundary;
  const named = [
    ...new Set(
      text
        .slice(0, end)
        .split(/\r?\n/)
        .filter(
          (line) =>
            !(failLinesSupplied && /^\s*FAIL:/i.test(line)) &&
            /^\s*(?:(?:PASS|FAIL|ERROR|SKIP):|(?:not )?ok \d+\b|# Subtest:|[✓✔✗✘×]\s)|\.\.\. (?:ok|FAIL|ERROR|skipped)\b|\b(?:PASSED|FAILED|SKIPPED)\s*$/.test(
              line,
            ),
        ),
    ),
  ];
  if (!named.length) return "";
  const kept: string[] = [];
  let remaining = limit - 350;
  for (const line of named) {
    if (line.length + 1 > remaining) continue;
    kept.push(line);
    remaining -= line.length + 1;
  }
  return [
    "VISP: named assertion results from earlier output (reporter text, not independently authenticated assertions):",
    ...kept,
    `VISP: output shortened for review; ${named.length - kept.length} earlier named result line(s) omitted. Other log regions omitted; full output remains in the local check-output log.`,
  ]
    .join("\n")
    .slice(0, limit);
}
