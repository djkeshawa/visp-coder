/** A browser claim to inspect, never proof that a browser actually ran. */
export function namesBrowserRunner(command: string): boolean {
  return /\b(?:playwright|cypress|puppeteer|selenium|webdriver|browser|ui-test|test-ui)\b/i.test(
    command,
  );
}
