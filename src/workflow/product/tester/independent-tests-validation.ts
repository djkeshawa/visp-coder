import type { TesterResponse } from "./independent-tests-model.js";

export const MAX_FILE_BYTES = 64 * 1024;
const MIN_ASSERTIONS = 3;

/**
 * The tester's own words say why it wrote no file (an interface it could not reach, a size limit
 * it could not meet); the generic text hid that in the R12 benchmark round.
 */
export function declineReason(notes: string): string {
  const said = notes.replace(/\s+/g, " ").trim().slice(0, 300);
  return said ? `The tester wrote no file: ${said}` : "No testable interface in the request";
}

export function onlyStructuralChecks(response: TesterResponse): boolean {
  const described = `${response.notes} ${response.tests.map((test) => test.name).join(" ")}`;
  return (
    /(?:cannot|can't|unable to|no way to) test (?:the )?behavio(?:u)?r/i.test(described) ||
    (response.tests.length > 0 &&
      response.tests.every((test) =>
        /\b(?:file exists|exists and parses|parses|syntax|file structure|source file)\b/i.test(
          test.name,
        ),
      ))
  );
}

/** A frozen test is only as good as its assertions; reject what cannot fail usefully. */
export function invalidFile(file: { name: string; content: string }): string | undefined {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(py|mjs)$/.test(file.name))
    return `Unsupported test file name ${JSON.stringify(file.name)}`;
  if (Buffer.byteLength(file.content) > MAX_FILE_BYTES) return "The test file is too large";
  const assertions =
    (file.content.match(/\bassert\w*|AssertionError/g)?.length ?? 0) +
    aliasedAssertions(file.content);
  if (assertions < MIN_ASSERTIONS)
    return `The test file has ${assertions} assertions; at least ${MIN_ASSERTIONS} are required`;
  return undefined;
}

/** Calls through Node's assert module imported under another name (`import check from "node:assert"`). */
function aliasedAssertions(content: string): number {
  const module = String.raw`['"](?:node:)?assert(?:/strict)?['"]`;
  const aliases = [
    ...content.matchAll(
      new RegExp(String.raw`import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+${module}`, "g"),
    ),
    ...content.matchAll(
      new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*${module}\s*\)`, "g"),
    ),
  ]
    .map((match) => match[1] ?? "")
    .filter((alias) => alias && !/^assert/.test(alias));
  return aliases.reduce(
    (count, alias) =>
      // Not a property of something else (`page.check(...)`, `obj.check.x`).
      count + (content.match(new RegExp(String.raw`(?<![\w$.])${alias}\s*[.(]`, "g"))?.length ?? 0),
    0,
  );
}
