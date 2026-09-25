import { fileEntityId } from "../ids.js";
import { isTestPath } from "../paths.js";
import type { Relation } from "../types.js";

/**
 * A test file's imports are the modules it exercises. The edge points from the
 * module to the test, so "what tests this?" is one hop from the module.
 */
export function extractTestRelations(
  path: string,
  importRelations: readonly Relation[],
): Relation[] {
  if (!isTestPath(path)) return [];

  const testEntity = fileEntityId(path);
  const seen = new Set<string>();
  const relations: Relation[] = [];

  for (const relation of importRelations) {
    if (relation.kind !== "imports" || relation.target === testEntity) continue;
    if (seen.has(relation.target)) continue;
    seen.add(relation.target);
    relations.push({
      source: relation.target,
      target: testEntity,
      kind: "tested_by",
      path,
      line: relation.line,
    });
  }
  return relations;
}
