import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchChrome } from "../../../src/testing/chrome-transport.js";

it("classifies missing shared libraries from stderr before adding recovery advice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "visp-chrome-diagnostic-"));
  try {
    const binary = join(directory, "chrome");
    await writeFile(
      binary,
      `#!${process.execPath}\nconsole.error('error while loading shared libraries: libnss3.so: cannot open shared object file'); process.exit(1);\n`,
      { mode: 0o755 },
    );
    await expect(launchChrome({ binary, startupTimeoutMs: 1000 })).rejects.toMatchObject({
      kind: "startup",
      message: expect.stringContaining("libnss3.so"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
