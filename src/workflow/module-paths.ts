export function isTestFile(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** Test support is not a second application boundary. Unknown paths stay implementation paths. */
export function implementationModulePaths(paths: readonly string[]): string[] {
  const normalized = paths.map((path) => path.replace(/\\/g, "/").replace(/^\.\//, ""));
  return [...new Set(normalized)].filter((path) => !isTestFile(path) && !isTestFile(`${path}/`));
}

export function isTestOnlyModule(paths: readonly string[]): boolean {
  return paths.length > 0 && implementationModulePaths(paths).length === 0;
}
