import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vispError } from "../../../src/core/errors.js";
import { err, ok } from "../../../src/core/result.js";
import type { Check } from "../../../src/doctor/checks.js";
import { applyFixes } from "../../../src/doctor/fix.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create({ "src/app.ts": "export const app = true;\n" });
});

afterEach(async () => {
  await workspace.destroy();
});

function failing(name: Check["name"]): Check {
  return { name, status: "warn", detail: "repair requested" };
}

describe("doctor repairs", () => {
  it("reports malformed recorded install preferences instead of guessing", async () => {
    await workspace.write(".visp/state/install.json", "{}\n");

    const repairs = await applyFixes(await workspace.state(), [failing("harness assets")], {
      guardHandshake: async () => ok(undefined),
    });

    expect(repairs).toEqual([expect.objectContaining({ name: "harness assets", done: false })]);
    expect(repairs[0]?.detail).toContain("Invalid");
  });

  it("builds a missing repository index and refreshes an existing one", async () => {
    const first = await applyFixes(await workspace.state(), [failing("repository index")]);
    expect(first).toEqual([
      expect.objectContaining({
        name: "repository index",
        done: true,
        detail: expect.stringMatching(/^Indexed /),
      }),
    ]);

    const second = await applyFixes(await workspace.state(), [failing("repository index")]);
    expect(second).toEqual([
      expect.objectContaining({
        name: "repository index",
        done: true,
        detail: "Already current",
      }),
    ]);
  });

  it("reports an unreadable authorization marker without removing anything", async () => {
    await workspace.write(".visp/state/implement-allowed/T001.json", "{}\n");

    const repairs = await applyFixes(await workspace.state(), [failing("authorization markers")]);

    expect(repairs).toEqual([
      expect.objectContaining({ name: "authorization markers", done: false }),
    ]);
    expect(repairs[0]?.detail).toContain("Invalid implement marker");
  });

  it("does not call a failed guard handshake a successful enforcement repair", async () => {
    const repairs = await applyFixes(await workspace.state(), [failing("enforcement")], {
      guardHandshake: async () => err(vispError("IO_ERROR", "guard executable is unavailable")),
    });

    expect(repairs).toEqual([expect.objectContaining({ name: "harness assets", done: false })]);
    expect(repairs[0]?.detail).toContain("guard executable is unavailable");
  });
});
