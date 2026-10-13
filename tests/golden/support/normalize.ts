import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BUILD_ID, VERSION } from "../../../src/core/version.js";

/**
 * Makes agent-visible text comparable across runs and machines, and nothing more. Only values
 * that differ between two runs of the same scenario are replaced: paths that hold the run's
 * temporary directories or this machine's tools, clock values, random identifiers, hashes of
 * those, and the build identity. Every replacement keeps its kind in the token (`<TIME>`,
 * `<UUID-2>`), and repeated values keep one number per snapshot, so a change that makes two
 * references diverge, or one value move, still shows in the snapshot.
 */
export interface NormalizeContext {
  /** Absolute paths to replace, most specific first, with the token that names them. */
  readonly paths?: readonly (readonly [string, string])[];
}

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");

export function normalize(text: string, context: NormalizeContext = {}): string {
  let result = text;
  for (const [path, token] of pathReplacements(context)) result = replacePath(result, path, token);
  result = result
    .replaceAll(BUILD_ID, "<BUILD-ID>")
    .replace(versionPattern(), "<VERSION>")
    // Temporary directories made per call: a prefix and the six random characters of mkdtemp.
    .replace(/(<TMP>\/[a-z]+(?:-[a-z]+)*-)[A-Za-z0-9]{6}(?![A-Za-z0-9])/g, "$1<RAND>")
    .replace(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\b/g,
      "<TIME>",
    )
    .replace(
      /("(?:durationMs|flipDurationMs|flipExtraMs|elapsedMs|ms|pid|startedAtMs)"\s*:\s*)\d+/g,
      "$1<N>",
    )
    .replace(/(Flip check extra time: )\d+( ms)/g, "$1<N>$2");
  result = numbered(result, /\bCAN-[a-f0-9]{32}\b/g, "CAN");
  result = numbered(
    result,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    "UUID",
  );
  // Abbreviated commit IDs where VISP lists commits as "<hash> <subject>".
  result = numbered(
    result,
    /(?<=(?:^|\n|\\n)(?:- )?|")(?=[a-f]*[0-9])(?=[0-9]*[a-f])[0-9a-f]{7,12}(?= )/g,
    "COMMIT",
  );
  result = numbered(result, /\b[0-9a-f]{64}\b/g, "SHA256");
  result = numbered(result, /\b[0-9a-f]{40}\b/g, "GIT");
  result = numbered(result, /\b[0-9a-f]{12,39}\b/g, "HEX");
  return result;
}

function pathReplacements(context: NormalizeContext): (readonly [string, string])[] {
  const machine: [string, string][] = [
    [REPOSITORY, "<REPO>"],
    [process.execPath, "<NODE>"],
    [realpathSync(process.execPath), "<NODE>"],
    [tmpdir(), "<TMP>"],
    [realpathSync(tmpdir()), "<TMP>"],
    [homedir(), "<HOME>"],
  ];
  const all = [...(context.paths ?? []), ...machine];
  // Longer paths first, so a workspace inside the temporary directory keeps its own token.
  return [...new Map(all.filter(([path]) => path.length > 1)).entries()].sort(
    ([left], [right]) => right.length - left.length,
  );
}

/** Replaces a path both as written and as escaped inside JSON text. */
function replacePath(text: string, path: string, token: string): string {
  const escaped = JSON.stringify(path).slice(1, -1);
  return text.replaceAll(path, token).replaceAll(escaped, token);
}

function versionPattern(): RegExp {
  const escaped = VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`, "g");
}

/** The same value keeps one number within one snapshot, in order of first appearance. */
function numbered(text: string, pattern: RegExp, kind: string): string {
  const seen = new Map<string, number>();
  return text.replace(pattern, (value) => {
    let index = seen.get(value);
    if (index === undefined) {
      index = seen.size + 1;
      seen.set(value, index);
    }
    return `<${kind}-${index}>`;
  });
}
