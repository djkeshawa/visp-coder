import { afterEach, describe, expect, it } from "vitest";
import { inspectValidationQuality } from "../../../../src/workflow/evidence/test-quality.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

const browserCase = `
import { test, expect } from '@playwright/test';
test('SCN001 searches the catalog', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox').fill('Copper');
  await expect(page.getByText('Copper Key')).toBeVisible();
});
`;
const launcher = `
import { spawnSync } from 'node:child_process';
const run = spawnSync('playwright', ['test', ...process.argv.slice(2)], {stdio: 'inherit'});
process.exit(run.status ?? 1);
`;

async function inspectBrowser(arguments_: string[] = []) {
  if (!workspace) throw new Error("Missing test workspace");
  return inspectValidationQuality(
    workspace.root,
    [{ layer: "functional", command: ["node", "scripts/browser-check.mjs", ...arguments_] }],
    {
      concerns: ["user-interaction"],
      scenarioIds: ["SCN001"],
      validationFiles: ["tests/browser.spec.mjs", "scripts/browser-check.mjs"],
    },
  );
}

describe("subscription calibration verification regressions", () => {
  it("reports a malformed unit test's syntax location instead of uncertain coverage", async () => {
    workspace = await TestWorkspace.create({
      "tests/catalog.test.mjs": [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { selectRows } from '../src/catalog.js';",
        "test('filtered count', () => { assert.equal(selectRows('Gold').total, 1); }});",
      ].join("\n"),
    });
    const findings = await inspectValidationQuality(
      workspace.root,
      [{ layer: "unit", command: ["node", "--test", "tests/catalog.test.mjs"] }],
      { requiredLayers: ["unit"] },
    );
    expect(findings).toEqual([
      expect.objectContaining({
        code: "validation-test-syntax-invalid",
        severity: "error",
        path: "tests/catalog.test.mjs",
        message: expect.stringMatching(/tests\/catalog\.test\.mjs:4:\d+.*syntax/i),
        recommendation: expect.stringMatching(/fix|correct/i),
      }),
    ]);
  });

  it("reports malformed browser syntax before claiming the scenario is missing", async () => {
    workspace = await TestWorkspace.create({
      "scripts/browser-check.mjs": launcher,
      "tests/browser.spec.mjs": browserCase.replace("});", "}});"),
    });
    const findings = await inspectBrowser(["tests/browser.spec.mjs"]);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-test-syntax-invalid",
        severity: "error",
        path: "tests/browser.spec.mjs",
      }),
    );
    expect(findings.map((finding) => finding.code)).not.toContain(
      "validation-browser-scenario-untraced",
    );
  });

  it("does not mislabel an unsupported test language as invalid syntax", async () => {
    workspace = await TestWorkspace.create({ "tests/test_catalog.py": "assert True\n" });
    const findings = await inspectValidationQuality(workspace.root, [
      { layer: "unit", command: ["pytest", "tests/test_catalog.py"] },
    ]);
    expect(findings.map((finding) => finding.code)).not.toContain("validation-test-syntax-invalid");
  });

  it("asks an opaque launcher for selected cases without crediting unrelated declarations", async () => {
    workspace = await TestWorkspace.create({
      "scripts/browser-check.mjs": launcher,
      "tests/browser.spec.mjs": browserCase,
    });
    const findings = await inspectBrowser();
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-browser-path-unassessed",
        severity: "warning",
        path: "scripts/browser-check.mjs",
      }),
    );
    expect(findings.map((finding) => finding.code)).not.toContain(
      "validation-browser-scenario-untraced",
    );
  });

  it("inspects the explicitly selected browser case separately from its launcher", async () => {
    workspace = await TestWorkspace.create({
      "scripts/browser-check.mjs": launcher,
      "tests/browser.spec.mjs": browserCase,
    });
    await expect(inspectBrowser(["tests/browser.spec.mjs"])).resolves.toEqual([]);
  });

  it("keeps direct case selection authoritative over another declared passing case", async () => {
    workspace = await TestWorkspace.create({
      "scripts/browser-check.mjs": launcher,
      "tests/browser.spec.mjs": browserCase,
      "tests/other.spec.mjs": browserCase.replace("SCN001", "SCN002"),
    });
    const findings = await inspectBrowser(["tests/other.spec.mjs"]);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-scenario-untraced", severity: "error" }),
    );
  });

  it("does not borrow an interaction from an unselected declared case", async () => {
    workspace = await TestWorkspace.create({
      "scripts/browser-check.mjs": launcher,
      "tests/browser.spec.mjs": browserCase,
      "tests/incomplete.spec.mjs": browserCase.replace(
        "await page.getByRole('textbox').fill('Copper');",
        "",
      ),
    });
    const findings = await inspectBrowser(["tests/incomplete.spec.mjs"]);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-browser-workflow-incomplete",
        severity: "error",
      }),
    );
  });

  it("retains direct browser scripts that also launch a server", async () => {
    workspace = await TestWorkspace.create({
      "scripts/browser-check.mjs": `
        import { spawn } from 'node:child_process';
        const server = spawn('node', ['server.mjs']);
        // SCN001 searches the catalog
        await page.goto('/');
        await page.getByRole('textbox').fill('Copper');
        await expect(page.getByText('Copper Key')).toBeVisible();
      `,
    });
    const findings = await inspectBrowser();
    expect(findings.map((finding) => finding.code)).not.toContain(
      "validation-browser-selection-unresolved",
    );
  });
});
