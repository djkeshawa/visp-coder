import { describe, expect, it } from "vitest";

/**
 * The harness itself, held to one property.
 *
 * `main.ts` decides it is the entrypoint by looking for "cli" anywhere in
 * `process.argv[1]`. Under vitest that argument is the worker's entry path,
 * which contains the checkout's own location — so in a repository cloned under,
 * say, `~/cli-tools/`, importing the module would run the real CLI against
 * vitest's arguments, print help, and call `process.exit`. Every case in this
 * directory would then fail at import with an error pointing nowhere near the
 * cause, so the workaround in `support/cli.ts` is worth a test of its own.
 */
describe("the cli harness", () => {
  it("does not run the cli at import time when argv[1] contains 'cli'", async () => {
    const entrypoint = process.argv[1];
    process.argv[1] = "/home/someone/cli-tools/repo/node_modules/tinypool/entry/process.js";

    try {
      const { runCli } = await import("./support/cli.js");
      const result = await runCli(process.cwd(), "--version");

      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      process.argv[1] = entrypoint as string;
    }
  });
});
