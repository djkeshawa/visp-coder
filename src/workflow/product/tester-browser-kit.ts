/**
 * Extra tester-prompt lines for requests that describe something to see in a browser (a
 * page, canvas or UI). Empty until the browser kit lands; for every other request too.
 * The kit is pasted into the tester's single test file, so it must not print its own
 * `FAIL:` or `PASS:` lines.
 */
export function testerBrowserKitLines(_request: string): readonly string[] {
  return [];
}
