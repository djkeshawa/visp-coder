import { tmpdir } from "node:os";
import { basename } from "node:path";
import { expect, it } from "vitest";

it("runs under the per-run temporary directory created by the global setup", () => {
  expect(basename(tmpdir())).toMatch(/^visp-run-/);
  expect(process.env.TMPDIR).toBe(tmpdir());
});
