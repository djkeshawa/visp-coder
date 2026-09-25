import { afterEach, describe, expect, it } from "vitest";
import { inspectValidationQuality } from "../../../../src/workflow/evidence/test-quality.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => workspace?.destroy());

const workflow = `test('SCN001 saves a document', async () => {
  await page.goto('/');
  await page.click('button');
  assert.equal(await page.evaluate(() => document.title), 'Saved');
});`;

async function inspect(source: string, args: string[] = []) {
  workspace = await TestWorkspace.create({ "scripts/browser.mjs": source });
  return inspectValidationQuality(
    workspace.root,
    [{ command: ["node", "scripts/browser.mjs", ...args], layer: "functional" }],
    { requiredLayers: ["functional"], scenarioIds: ["SCN001"] },
  );
}

describe("browser evidence integrity", () => {
  it.each(["const page", "globalThis.page"])(
    "rejects browser methods supplied by a local object: %s",
    async (binding) => {
      const findings = await inspect(`${binding} = {
        async goto() {}, async click() {}, async evaluate() { return 'Saved'; }
      }; ${workflow}`);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: "validation-browser-local-double",
          severity: "error",
        }),
      );
    },
  );

  it("does not credit locally registered callbacks as executed browser cases", async () => {
    const findings = await inspect(`const callbacks = [];
      function test(name, callback) { callbacks.push(callback); }
      ${workflow}`);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-browser-registration-unassessed",
        severity: "warning",
      }),
    );
  });

  it("does not assume an unbound test function is a real test framework", async () => {
    const findings = await inspect(workflow);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-registration-unassessed" }),
    );
  });

  it("rejects successful acceptance receipts emitted from an error handler", async () => {
    const findings = await inspect(`import { run } from './runner.mjs';
      try { await run(); } catch (error) {
        if (/EPERM/.test(error.message)) console.log('VISP_ASSERT AC001 passed');
        else throw error;
      } ${workflow}`);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-success-on-error",
        severity: "error",
      }),
    );
  });

  it("keeps custom executable browser paths advisory instead of forcing a rewrite", async () => {
    const findings = await inspect(`import { spawn } from 'node:child_process';
      import { readFileSync } from 'node:fs';
      const source = readFileSync('index.html', 'utf8');
      assert.ok(source.includes('main'));
      spawn('browser', ['--headless']);`);
    expect(findings.some((finding) => finding.severity === "error")).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-browser-path-unassessed",
        severity: "warning",
      }),
    );
  });

  it("does not interpret an arbitrary case selector as all registered scenarios", async () => {
    const findings = await inspect(`import { test, expect } from '@playwright/test'; ${workflow}`, [
      "--case",
      "other",
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-browser-path-unassessed",
        severity: "warning",
      }),
    );
  });

  it("does not confuse fixture data or a failed receipt with fake execution", async () => {
    const findings = await inspect(`import { test, expect } from '@playwright/test';
      const help = "const page = { goto() {}, evaluate() {} }";
      try { console.log(help); } catch (error) { console.log('VISP_ASSERT AC001 failed'); throw error; }
      ${workflow}`);
    expect(findings).toEqual([]);
  });

  it("does not reject unused browser-shaped fixture data", async () => {
    const findings = await inspect(`import { test, expect } from '@playwright/test';
      const unused = { goto() {}, evaluate() { return 'Saved'; } }; ${workflow}`);
    expect(findings).toEqual([]);
  });

  it("inspects imported runner support for success-on-error without borrowing its scenarios", async () => {
    workspace = await TestWorkspace.create({
      "scripts/browser.mjs": "import { run } from './support.mjs'; await run();",
      "scripts/support.mjs": `export async function run() {
        try { throw Error('unavailable'); } catch { console.log('VISP_ASSERT AC001 passed'); }
      }`,
    });
    const findings = await inspectValidationQuality(workspace.root, [
      { command: ["node", "scripts/browser.mjs"], layer: "functional" },
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-success-on-error", path: "scripts/support.mjs" }),
    );
  });
});
