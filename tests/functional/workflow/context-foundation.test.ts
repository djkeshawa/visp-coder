import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productProject } from "../support/product.js";
import { TestProject } from "../support/project.js";

describe("workflow foundation", () => {
  let uninstalled: TestProject;
  let drifted: TestProject;

  beforeAll(async () => {
    uninstalled = await TestProject.create({ "src/app.ts": "export const value = 1;\n" });
    uninstalled.run("init", "--harness", "generic");

    ({ project: drifted } = await productProject());
    await rm(join(drifted.root, "AGENTS.visp.md"));
  });

  afterAll(async () => {
    await Promise.all([uninstalled.destroy(), drifted.destroy()]);
  });

  it("does not start a feature before the harness can guide and constrain the model", () => {
    const { result, envelope } = uninstalled.json<unknown>("feature", "Foundation");

    expect(result.exitCode).not.toBe(0);
    expect(envelope.error).toMatchObject({ code: "STAGE_BLOCKED", recovery: "visp install" });
  });

  it("returns a read-only next action before a feature exists", () => {
    const { envelope } = uninstalled.json<{ action: string; command: string; mayEdit: boolean }>(
      "next",
    );
    expect(envelope.data).toMatchObject({ action: "understand", mayEdit: false });
    expect(envelope.data?.command).toContain("visp feature");
  });

  it("does not expose an implementation brief before the harness can enforce it", () => {
    const { result, envelope } = drifted.json<unknown>("work", "--task", "T001");

    expect(result.exitCode).not.toBe(0);
    expect(envelope.error).toMatchObject({
      code: "STAGE_BLOCKED",
      recovery: "visp install",
    });
    expect(result.stdout).not.toContain("Compiled context");
  });
});
