import { UNPARSED_SOURCE_EXTENSIONS } from "./constants.js";
import { extensionOf, isIndexableProjectPath, isTestPath } from "./paths.js";

export function isApplicationSource(path: string): boolean {
  return (
    !isTestPath(path) &&
    (isIndexableProjectPath(path) || UNPARSED_SOURCE_EXTENSIONS.has(extensionOf(path)))
  );
}

/** Shared explanations, not an estimate of semantic or behavioral coverage. */
export function graphCoverageNotes(coverage: {
  readonly sourceFiles: number;
  readonly declarationsOnlyInTests: boolean;
  readonly htmlFileCount: number;
}): string[] {
  const notes: string[] = [];
  if (coverage.sourceFiles > 0 && coverage.declarationsOnlyInTests) {
    notes.push(
      "The snapshot has declarations only in test files; this does not establish coverage of the task's application code.",
    );
  }
  if (coverage.htmlFileCount > 0) {
    notes.push(
      "HTML coverage includes script links and inline JavaScript declarations/imports. Multiple inline scopes omit call resolution; dynamic behavior and rendered quality require observation.",
    );
  }
  return notes;
}
