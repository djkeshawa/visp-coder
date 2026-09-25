import { afterEach, describe, expect, it } from "vitest";
import { inspectValidationQuality } from "../../../../src/workflow/evidence/test-quality.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

async function browserFindings(source: string, args: string[] = []) {
  workspace = await TestWorkspace.create({
    "tests/browser.spec.mjs": `import { test, expect } from '@playwright/test';\n${source}`,
  });
  return inspectValidationQuality(
    workspace.root,
    [{ command: ["npx", "playwright", "test", ...args], layer: "functional" }],
    {
      concerns: ["user-interaction"],
      scenarioIds: ["SCN001"],
      validationFiles: ["tests/browser.spec.mjs"],
    },
  );
}

describe("evidence classification regression controls", () => {
  it.each(["html.includes('Save')", "html.split('Save').length > 1"])(
    "classifies equivalent source-text assertions as static: %s",
    async (expression) => {
      workspace = await TestWorkspace.create({
        "tests/source.test.mjs": [
          "import assert from 'node:assert/strict';",
          "import { readFileSync } from 'node:fs';",
          "const html = readFileSync('index.html', 'utf8');",
          `assert.ok(${expression});`,
        ].join("\n"),
      });
      const findings = await inspectValidationQuality(workspace.root, [
        { command: ["node", "tests/source.test.mjs"], layer: "unit" },
      ]);
      expect(findings).toContainEqual(
        expect.objectContaining({ code: "validation-layer-static-only", severity: "error" }),
      );
    },
  );

  it("does not treat an unused project import as proof of executing project behavior", async () => {
    workspace = await TestWorkspace.create({
      "tests/source.test.mjs": [
        "import assert from 'node:assert/strict';",
        "import { readFileSync } from 'node:fs';",
        "import { save } from '../src/store.mjs';",
        "assert.ok(readFileSync('src/store.mjs', 'utf8').includes('save'));",
      ].join("\n"),
    });
    const findings = await inspectValidationQuality(workspace.root, [
      { command: ["node", "tests/source.test.mjs"], layer: "unit" },
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-layer-unassessed", severity: "warning" }),
    );
  });

  it("does not reject real VM execution as merely source inspection", async () => {
    workspace = await TestWorkspace.create({
      "tests/embedded.test.mjs": [
        "import assert from 'node:assert/strict';",
        "import { readFileSync } from 'node:fs';",
        "import { runInNewContext } from 'node:vm';",
        "const html = readFileSync('index.html', 'utf8');",
        "const script = html.match(/<script>([\\s\\S]*)<\\/script>/)[1];",
        "assert.equal(runInNewContext(script + '; count()'), 3);",
      ].join("\n"),
    });
    const findings = await inspectValidationQuality(workspace.root, [
      { command: ["node", "tests/embedded.test.mjs"], layer: "unit" },
    ]);
    expect(findings.some((finding) => finding.severity === "error")).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-layer-unassessed" }),
    );
  });

  it("does not let an unassessed executor establish a required unit layer", async () => {
    workspace = await TestWorkspace.create({
      "tests/embedded.test.mjs": [
        "import assert from 'node:assert/strict';",
        "import { readFileSync } from 'node:fs';",
        "const script = readFileSync('index.html', 'utf8');",
        "assert.equal(new Function(script)(), 3);",
      ].join("\n"),
    });
    const findings = await inspectValidationQuality(
      workspace.root,
      [{ command: ["node", "tests/embedded.test.mjs"], layer: "unit" }],
      { requiredLayers: ["unit"] },
    );

    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-layer-unestablished", severity: "error" }),
    );
  });

  it("does not borrow a click from another named browser scenario", async () => {
    const findings = await browserFindings(`
      test('SCN001 saves a document', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByText('Saved')).toBeVisible();
      });
      test('SCN002 opens a document', async ({ page }) => {
        await page.goto('/');
        await page.getByRole('button').click();
        await expect(page.getByText('Opened')).toBeVisible();
      });
    `);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-workflow-incomplete" }),
    );
  });

  it("does not borrow an outcome assertion from another named test", async () => {
    const findings = await browserFindings(`
      test('SCN001 saves a document', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('button')).toBeVisible();
        await page.getByRole('button').click();
      });
      test('SCN002 reads a document', async ({ page }) => {
        await expect(page.getByText('Saved')).toBeVisible();
      });
    `);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-outcome-unasserted" }),
    );
  });

  it("cannot satisfy a browser interaction using comments or string literals", async () => {
    const findings = await browserFindings(`
      test('SCN001 saves a document', async ({ page }) => {
        await page.goto('/');
        // page.getByRole('button').click();
        const instructions = "page.click()";
        await expect(page.getByText('Saved')).toBeVisible();
      });
    `);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-workflow-incomplete" }),
    );
  });

  it("does not credit a scenario excluded by the actual test selector", async () => {
    const findings = await browserFindings(
      `
        test('SCN001 saves', async ({ page }) => {
          await page.goto('/');
          await page.getByRole('button').click();
          await expect(page.getByText('Saved')).toBeVisible();
        });
        test('SCN002 loads', async ({ page }) => { await page.goto('/'); });
      `,
      ["--grep", "SCN002"],
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-scenario-untraced" }),
    );
  });

  it("reports custom command-mode dispatch as unassessed instead of merging its branches", async () => {
    const findings = await browserFindings(`
      const mode = process.argv[2];
      if (mode === 'boot') {
        await page.goto('/');
        await page.getByRole('button').click();
        await expect(page.getByText('Ready')).toBeVisible();
      } else {
        // SCN001
        await page.goto('/?probe=save');
        await expect(page.getByText('Saved')).toBeVisible();
      }
    `);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-path-unassessed", severity: "warning" }),
    );
  });

  it("accepts a direct named scenario with a scoped beforeEach navigation", async () => {
    const findings = await browserFindings(`
      test.beforeEach(async ({ page }) => { await page.goto('/'); });
      test('SCN001 saves a document', async ({ page }) => {
        await page.getByRole('button').click();
        await expect(page.getByText('Saved')).toBeVisible();
      });
    `);
    expect(findings).toEqual([]);
  });

  it("reports indirect helpers without falsely saying the workflow does not execute", async () => {
    const findings = await browserFindings(`
      import { saveDocument } from './browser-helpers.mjs';
      test('SCN001 saves a document', async ({ page }) => {
        await saveDocument(page);
        await expect(page.getByText('Saved')).toBeVisible();
      });
    `);
    expect(findings.some((finding) => finding.severity === "error")).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-path-unassessed" }),
    );
  });

  it("does not credit the body of an unused callback", async () => {
    const findings = await browserFindings(`
      test('SCN001 saves', async ({ page }) => {
        await page.goto('/');
        const unused = async () => { await page.getByRole('button').click(); };
        await expect(page.getByText('Saved')).toBeVisible();
      });
    `);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-path-unassessed" }),
    );
  });

  it("does not fall back to crediting skipped test bodies", async () => {
    const findings = await browserFindings(`
      test.skip('SCN001 saves', async ({ page }) => {
        await page.goto('/');
        await page.getByRole('button').click();
        await expect(page.getByText('Saved')).toBeVisible();
      });
    `);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-path-unassessed" }),
    );
  });

  it("respects exclusive browser selection", async () => {
    const findings = await browserFindings(`
      test('SCN001 saves', async ({ page }) => {
        await page.goto('/');
        await page.getByRole('button').click();
        await expect(page.getByText('Saved')).toBeVisible();
      });
      test.only('SCN002 loads', async ({ page }) => { await page.goto('/'); });
    `);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-scenario-untraced" }),
    );
  });

  it("matches a selector against the enclosing suite title", async () => {
    const findings = await browserFindings(
      `
      test.describe('documents', () => {
        test('SCN001 saves', async ({ page }) => {
          await page.goto('/');
          await page.getByRole('button').click();
          await expect(page.getByText('Saved')).toBeVisible();
        });
      });
    `,
      ["--grep", "documents SCN001"],
    );
    expect(findings).toEqual([]);
  });

  it("masks Unicode comments and strings without shifting browser operations", async () => {
    const findings = await browserFindings(`
      test('SCN001 saves 📄', async ({ page }) => {
        const label = '✓'; // page.click('fake');
        await page.goto('/');
        await expect(page.getByText(label)).toBeVisible();
      });
    `);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-workflow-incomplete" }),
    );
  });

  it.each([
    "const { readFileSync } = require('node:fs'); const { save } = require('../src/store.cjs'); assert.ok(readFileSync('src/store.cjs', 'utf8').split('save').length); save();",
    "import { runInNewContext as execute } from 'node:vm'; import { readFileSync } from 'node:fs'; const code = readFileSync('index.html', 'utf8').split('<script>')[1]; assert.equal(execute(code), 3);",
  ])("keeps dynamic or CommonJS execution unassessed, not static", async (source) => {
    workspace = await TestWorkspace.create({ "tests/executor.test.mjs": source });
    const findings = await inspectValidationQuality(workspace.root, [
      { command: ["node", "tests/executor.test.mjs"], layer: "unit" },
    ]);
    expect(findings.some((finding) => finding.severity === "error")).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-layer-unassessed" }),
    );
  });

  it("keeps regex source assertions classified as static", async () => {
    workspace = await TestWorkspace.create({
      "tests/source.test.mjs":
        "import { readFileSync } from 'node:fs'; assert.ok(/Save/.test(readFileSync('index.html', 'utf8')));",
    });
    const findings = await inspectValidationQuality(workspace.root, [
      { command: ["node", "tests/source.test.mjs"], layer: "unit" },
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-layer-static-only" }),
    );
  });

  it("does not require another outcome assertion after an unrelated cleanup action", async () => {
    const findings = await browserFindings(`
      test('SCN001 saves', async ({ page }) => {
        await page.goto('/');
        await page.getByRole('button', { name: 'Save' }).click();
        await expect(page.getByText('Saved')).toBeVisible();
        await page.getByRole('button', { name: 'Close dialog' }).click();
      });
    `);
    expect(findings).toEqual([]);
  });

  it("does not falsely reject a namespaced project helper", async () => {
    const findings = await browserFindings(`
      import * as flows from './browser-helpers.mjs';
      test('SCN001 saves', async ({ page }) => {
        await flows.saveDocument(page);
        await expect(page.getByText('Saved')).toBeVisible();
      });
    `);
    expect(findings.some((finding) => finding.severity === "error")).toBe(false);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-path-unassessed" }),
    );
  });

  it.each([
    "const evaluate = new Function(script); assert.equal(evaluate(), 3);",
    "assert.equal(new Function(script)(), 3);",
  ])(
    "distinguishes executing a constructed function from syntax-only compilation",
    async (execution) => {
      workspace = await TestWorkspace.create({
        "tests/embedded.test.mjs": `import { readFileSync } from 'node:fs'; const script = readFileSync('index.html', 'utf8').split('<script>')[1]; ${execution}`,
      });
      const findings = await inspectValidationQuality(workspace.root, [
        { command: ["node", "tests/embedded.test.mjs"], layer: "unit" },
      ]);
      expect(findings.some((finding) => finding.severity === "error")).toBe(false);
      expect(findings).toContainEqual(
        expect.objectContaining({ code: "validation-layer-unassessed" }),
      );
    },
  );
});
