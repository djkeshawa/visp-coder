import { UNPARSED_SOURCE_EXTENSIONS } from "./constants.js";
import { extensionOf, isIndexableProjectPath, isTestPath } from "./paths.js";

export function isApplicationSource(path: string): boolean {
  return (
    !isTestPath(path) &&
    (isIndexableProjectPath(path) || UNPARSED_SOURCE_EXTENSIONS.has(extensionOf(path)))
  );
}
