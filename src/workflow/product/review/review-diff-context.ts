interface Definition {
  line: number;
  header: string;
}

/** One scan per file, bounded by the diff snapshot limits; no graph build or extra Git call. */
export function diffDefinitions(path: string, old: Uint8Array, current?: Uint8Array) {
  const pattern = /\.py$/i.test(path)
    ? /^\s*(?:async\s+)?(?:def|class)\s+\w+/
    : /\.[cm]?[jt]sx?$/i.test(path)
      ? /^\s*(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|(?:export\s+)?class\b|(?:export\s+)?(?:const|let|var)\s+\w+\s*=.*(?:=>|function\b)|(?!(?:if|for|while|switch|catch|with)\s*\()(?:async\s+)?\w+\s*\([^;]*\)\s*\{)/
      : /^\s*(?:def|class|function)\s+\w+/;
  const scan = (bytes?: Uint8Array): Definition[] =>
    bytes === undefined
      ? []
      : Buffer.from(bytes)
          .toString("utf8")
          .split("\n")
          .flatMap((header, index) =>
            pattern.test(header) ? [{ line: index + 1, header: header.trim().slice(0, 240) }] : [],
          );
  return { old: scan(old), current: scan(current) };
}

function preceding(definitions: Definition[], line: number) {
  let low = 0;
  let high = definitions.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((definitions[middle]?.line ?? Number.POSITIVE_INFINITY) <= line) low = middle + 1;
    else high = middle;
  }
  return definitions[low - 1];
}

/** Labels annotate the hunk without pretending distant definitions are adjacent diff lines. */
export function enclosingDiffContext(
  patch: string,
  definitions: ReturnType<typeof diffDefinitions>,
) {
  return patch.replace(
    /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@).*$/gm,
    (header, range: string, old: string, current: string, offset: number) => {
      const contextLines = leadingContextLines(patch.slice(offset + header.length + 1));
      const oldLine = Number(old) + contextLines;
      const currentLine = Number(current) + contextLines;
      const before = preceding(definitions.old, oldLine);
      const after = preceding(definitions.current, currentLine);
      const labels = [
        ...(before ? [`old line ${before.line}: ${before.header}`] : []),
        ...(after && after.header !== before?.header
          ? [`new line ${after.line}: ${after.header}`]
          : []),
      ];
      return labels.length ? `${range} Enclosing definition (${labels.join("; ")})` : header;
    },
  );
}

function leadingContextLines(body: string) {
  let count = 0;
  let offset = 0;
  while (body[offset] === " ") {
    const next = body.indexOf("\n", offset);
    if (next < 0) break;
    count++;
    offset = next + 1;
  }
  return count;
}
