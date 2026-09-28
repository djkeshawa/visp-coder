import { afterEach, expect, it, vi } from "vitest";
import {
  productComparisonEnvironmentDigest,
  productSourceDigest,
} from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";

const setups: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(setups.splice(0).map(({ workspace }) => workspace.destroy()));
});

it("keeps subject freshness across host changes while retaining comparison context", async () => {
  const setup = await productWorkspace();
  setups.push(setup);
  const state = await setup.workspace.state();
  const before = await productSourceDigest(state, setup.brief);
  const comparison = await productComparisonEnvironmentDigest(state, setup.brief);
  for (const name of [
    "TERM",
    "COLUMNS",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_PID",
  ]) {
    vi.stubEnv(name, "changed-host-context");
    expect(await productSourceDigest(state, setup.brief)).toEqual(before);
    expect(await productComparisonEnvironmentDigest(state, setup.brief)).not.toEqual(comparison);
  }
  const brief = {
    ...setup.brief,
    checks: setup.brief.checks.map((check) => ({ ...check, environmentVariables: ["APP_MODE"] })),
  };
  const declared = await productSourceDigest(state, brief);
  vi.stubEnv("APP_MODE", "production");
  expect(await productSourceDigest(state, brief)).not.toEqual(declared);
});
