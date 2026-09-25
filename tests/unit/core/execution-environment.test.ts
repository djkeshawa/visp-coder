import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { resolvedProductExecutionEnvironment } from "../../../src/core/execution-environment.js";

const inherited = process.env.PYTHONPYCACHEPREFIX;
afterEach(() => {
  if (inherited === undefined) delete process.env.PYTHONPYCACHEPREFIX;
  else process.env.PYTHONPYCACHEPREFIX = inherited;
});

it("redirects Python bytecode caches outside the product by default", async () => {
  delete process.env.PYTHONPYCACHEPREFIX;
  const prefix = (await resolvedProductExecutionEnvironment()).PYTHONPYCACHEPREFIX;
  expect(prefix?.startsWith(tmpdir())).toBe(true);
});

it("keeps an operator's explicit Python cache location", async () => {
  process.env.PYTHONPYCACHEPREFIX = "/operator/cache";
  expect((await resolvedProductExecutionEnvironment()).PYTHONPYCACHEPREFIX).toBe("/operator/cache");
});
