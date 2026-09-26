export function isTestFile(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}
