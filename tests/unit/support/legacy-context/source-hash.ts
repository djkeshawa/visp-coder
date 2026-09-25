import { FILE } from "../../../../src/core/constants.js";
import { hashValue, sha256 } from "../../../../src/core/hash.js";

/**
 * The hash a manifest records for one source artifact.
 *
 * The task graph is hashed with per-task `status` stripped: `visp done`
 * flipping pending→done is the loop's own bookkeeping, and counting it as
 * drift marked every task of every real run stale — a signal that carried
 * zero information. A change to anything else in the graph (scope, commands,
 * titles) still counts.
 */
export function sourceHash(sourcePath: string, text: string): string {
  if (!sourcePath.endsWith(`/${FILE.tasks}`) && sourcePath !== FILE.tasks) return sha256(text);

  try {
    const parsed = JSON.parse(text) as { tasks?: unknown };
    if (!Array.isArray(parsed.tasks)) return sha256(text);
    return hashValue({
      ...parsed,
      tasks: parsed.tasks.map((task) =>
        typeof task === "object" && task !== null
          ? canonicalTaskSource(task as Record<string, unknown>)
          : task,
      ),
    });
  } catch {
    return sha256(text);
  }
}

function canonicalTaskSource(task: Record<string, unknown>): Record<string, unknown> {
  const probeRoles = Array.isArray(task.probeRoles) ? task.probeRoles : [];
  const concerns = Array.isArray(task.concerns) ? task.concerns : [];
  return {
    ...task,
    status: undefined,
    // `probeRoles` was added as an empty-array default. Omitting an empty value
    // keeps a status-only rewrite of an older task artifact hash-compatible.
    probeRoles: probeRoles.length > 0 ? probeRoles : undefined,
    // Same compatibility rule for the additive, empty-by-default concerns field.
    concerns: concerns.length > 0 ? concerns : undefined,
  };
}
