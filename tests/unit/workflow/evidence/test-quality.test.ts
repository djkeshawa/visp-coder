import { afterEach, describe, expect, it } from "vitest";
import { inspectValidationQuality } from "../../../../src/workflow/evidence/test-quality.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;

afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

describe("validation layer integrity", () => {
  it("rejects source-regex checks presented as unit evidence", async () => {
    workspace = await TestWorkspace.create({
      "policy.js": "export const limit = 570;\n",
      "policy.test.mjs": [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'const source = readFileSync("policy.js", "utf8");',
        "assert.match(source, /limit\\s*=\\s*570/);",
        "",
      ].join("\n"),
    });

    const findings = await inspectValidationQuality(workspace.root, [
      { command: ["node", "--test", "policy.test.mjs"], layer: "unit" },
    ]);

    expect(findings.map((finding) => finding.code)).toContain("validation-layer-static-only");
  });

  it("rejects source-string smoke checks presented as unit evidence", async () => {
    workspace = await TestWorkspace.create({
      "index.html": '<script>const launch = "opposite drag";</script>\n',
      "smoke.test.mjs": [
        'import { readFileSync } from "node:fs";',
        'const html = readFileSync("index.html", "utf8");',
        'if (!html.includes("opposite drag")) throw new Error("launch rule missing");',
        'new Function(html.match(/<script>([\\s\\S]*)<\\/script>/)?.[1] ?? "");',
        "",
      ].join("\n"),
    });

    const findings = await inspectValidationQuality(workspace.root, [
      { command: ["node", "--test", "smoke.test.mjs"], layer: "unit" },
    ]);

    expect(findings.map((finding) => finding.code)).toContain("validation-layer-static-only");
  });

  it("accepts a unit test that imports and executes project behavior", async () => {
    workspace = await TestWorkspace.create({
      "src/gravity.mjs": "export const step = (y) => y + 1;\n",
      "tests/gravity.test.mjs": [
        'import assert from "node:assert/strict";',
        'import { step } from "../src/gravity.mjs";',
        "assert.equal(step(1), 2);",
        "",
      ].join("\n"),
    });

    await expect(
      inspectValidationQuality(workspace.root, [
        { command: ["node", "--test", "tests/gravity.test.mjs"], layer: "unit" },
      ]),
    ).resolves.toEqual([]);
  });

  it("allows source-shape checks when honestly labelled static", async () => {
    workspace = await TestWorkspace.create({
      "shape.test.mjs": [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'assert.match(readFileSync("x.js", "utf8"), /export/);',
        "",
      ].join("\n"),
    });

    await expect(
      inspectValidationQuality(workspace.root, [
        { command: ["node", "--test", "shape.test.mjs"], layer: "static" },
      ]),
    ).resolves.toEqual([]);
  });

  it("rejects a screenshot capture presented as functional evidence", async () => {
    workspace = await TestWorkspace.create();

    const findings = await inspectValidationQuality(workspace.root, [
      {
        command: ["npx", "playwright", "screenshot", "http://localhost:3000", "page.png"],
        layer: "functional",
      },
    ]);

    expect(findings.map((finding) => finding.code)).toContain(
      "validation-functional-observation-only",
    );
  });

  it("rejects opening a browser without assertions as functional evidence", async () => {
    workspace = await TestWorkspace.create();

    const findings = await inspectValidationQuality(workspace.root, [
      {
        command: ["bash", "scripts/playwright_cli.sh", "open", "http://localhost:3000"],
        layer: "functional",
      },
    ]);

    expect(findings.map((finding) => finding.code)).toContain(
      "validation-functional-observation-only",
    );
  });

  it("rejects a headless DOM dump presented as functional browser evidence", async () => {
    workspace = await TestWorkspace.create();

    const findings = await inspectValidationQuality(workspace.root, [
      {
        command: ["google-chrome", "--headless", "--dump-dom", "http://localhost:3000"],
        layer: "functional",
      },
    ]);

    expect(findings.map((finding) => finding.code)).toContain(
      "validation-functional-observation-only",
    );
  });

  it("rejects a text search presented as integration evidence", async () => {
    workspace = await TestWorkspace.create();

    const findings = await inspectValidationQuality(workspace.root, [
      { command: ["rg", "expected state", "src"], layer: "integration" },
    ]);

    expect(findings.map((finding) => finding.code)).toContain("validation-layer-static-only");
  });

  it("rejects a browser runner help command presented as functional evidence", async () => {
    workspace = await TestWorkspace.create();

    const findings = await inspectValidationQuality(workspace.root, [
      {
        command: ["bash", "scripts/playwright_cli.sh", "--help"],
        layer: "functional",
      },
    ]);

    expect(findings.map((finding) => finding.code)).toContain("validation-command-no-evidence");
  });

  it("requires an interaction contract for browser-backed user interaction", async () => {
    workspace = await TestWorkspace.create({
      "tests/ui.spec.mjs": [
        'import { test, expect } from "@playwright/test";',
        'test("loads", async ({ page }) => {',
        '  await page.goto("/");',
        '  await expect(page.locator("main")).toBeVisible();',
        "});",
      ].join("\n"),
    });

    const findings = await inspectValidationQuality(
      workspace.root,
      [{ command: ["npx", "playwright", "test"], layer: "functional" }],
      { concerns: ["user-interaction"], validationFiles: ["tests/ui.spec.mjs"] },
    );

    expect(findings.map((finding) => finding.code)).toContain(
      "validation-browser-workflow-incomplete",
    );
  });

  it("rejects an uninspectable shell wrapper as the sole functional browser contract", async () => {
    workspace = await TestWorkspace.create({
      "tests/browser-smoke.sh": [
        "#!/usr/bin/env bash",
        "playwright-cli open http://localhost:3000",
        "playwright-cli click '#start'",
        "playwright-cli eval 'document.body.textContent.includes(\"Ready\")'",
      ].join("\n"),
    });

    const findings = await inspectValidationQuality(
      workspace.root,
      [{ command: ["bash", "tests/browser-smoke.sh"], layer: "functional" }],
      { concerns: ["user-interaction"], validationFiles: ["tests/browser-smoke.sh"] },
    );

    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-browser-contract-uninspectable",
        severity: "error",
      }),
    );
  });

  it("rejects a test-only state jump as functional browser proof", async () => {
    workspace = await TestWorkspace.create({
      "tests/ui.spec.mjs": [
        'import { test, expect } from "@playwright/test";',
        'test("SCN001 reaches the boss", async ({ page }) => {',
        '  await page.goto("/");',
        '  await page.getByRole("button", { name: "Launch" }).click();',
        "  await page.evaluate(() => window.__voidrun.demo('boss'));",
        '  await expect(page.getByText("Boss")).toBeVisible();',
        "});",
      ].join("\n"),
    });

    const findings = await inspectValidationQuality(
      workspace.root,
      [{ command: ["npx", "playwright", "test"], layer: "functional" }],
      {
        concerns: ["user-interaction"],
        validationFiles: ["tests/ui.spec.mjs"],
        scenarioIds: ["SCN001"],
      },
    );

    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-state-bypass", severity: "error" }),
    );
  });

  it("requires visible-output browser evidence to exercise a viewport and layout assertion", async () => {
    workspace = await TestWorkspace.create({
      "tests/ui.spec.mjs": [
        'import { test, expect } from "@playwright/test";',
        'test("shows the primary action", async ({ page }) => {',
        '  await page.goto("/");',
        '  await page.getByRole("button", { name: "Save" }).click();',
        '  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();',
        "});",
      ].join("\n"),
    });

    const findings = await inspectValidationQuality(
      workspace.root,
      [{ command: ["npx", "playwright", "test"], layer: "functional" }],
      { concerns: ["visible-output"], validationFiles: ["tests/ui.spec.mjs"] },
    );

    expect(findings.map((finding) => finding.code)).toContain(
      "validation-browser-contract-incomplete",
    );
  });

  it("accepts a browser contract that checks viewport fit and essential visibility", async () => {
    workspace = await TestWorkspace.create({
      "tests/ui.spec.mjs": [
        'import { test, expect } from "@playwright/test";',
        'test("fits the viewport", async ({ page }) => {',
        "  await page.setViewportSize({ width: 390, height: 844 });",
        '  await page.goto("/");',
        '  await page.getByRole("button", { name: "Save" }).click();',
        "  const layout = await page.evaluate(() => ({",
        "    scrollWidth: document.documentElement.scrollWidth,",
        "    clientWidth: document.documentElement.clientWidth,",
        "  }));",
        "  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);",
        '  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();',
        "});",
      ].join("\n"),
    });

    await expect(
      inspectValidationQuality(
        workspace.root,
        [{ command: ["npx", "playwright", "test"], layer: "functional" }],
        { concerns: ["visible-output"], validationFiles: ["tests/ui.spec.mjs"] },
      ),
    ).resolves.toEqual([]);
  });

  it("requires browser evidence to name the workflow scenario it claims to prove", async () => {
    workspace = await TestWorkspace.create({
      "tests/ui.spec.mjs": [
        'import { test, expect } from "@playwright/test";',
        'test("completes the workflow", async ({ page }) => {',
        '  await page.goto("/");',
        '  await page.getByRole("button", { name: "Run" }).click();',
        '  await expect(page.getByText("Complete")).toBeVisible();',
        "});",
      ].join("\n"),
    });

    const findings = await inspectValidationQuality(
      workspace.root,
      [{ command: ["npx", "playwright", "test"], layer: "functional" }],
      {
        concerns: ["user-interaction"],
        validationFiles: ["tests/ui.spec.mjs"],
        scenarioIds: ["SCN001"],
      },
    );

    expect(findings.map((finding) => finding.code)).toContain(
      "validation-browser-scenario-untraced",
    );
  });

  it("requires an outcome assertion after the workflow interaction", async () => {
    workspace = await TestWorkspace.create({
      "tests/ui.spec.mjs": [
        'import { test, expect } from "@playwright/test";',
        'test("SCN001 starts the workflow", async ({ page }) => {',
        '  await page.goto("/");',
        '  await expect(page.getByRole("button", { name: "Run" })).toBeVisible();',
        '  await page.getByRole("button", { name: "Run" }).click();',
        "});",
      ].join("\n"),
    });

    const findings = await inspectValidationQuality(
      workspace.root,
      [{ command: ["npx", "playwright", "test"], layer: "functional" }],
      {
        concerns: ["user-interaction"],
        validationFiles: ["tests/ui.spec.mjs"],
        scenarioIds: ["SCN001"],
      },
    );

    expect(findings.map((finding) => finding.code)).toContain(
      "validation-browser-outcome-unasserted",
    );
  });

  it("accepts scenario-attributed browser evidence with a downstream assertion", async () => {
    workspace = await TestWorkspace.create({
      "tests/ui.spec.mjs": [
        'import { test, expect } from "@playwright/test";',
        'test("SCN001 reaches completion", async ({ page }) => {',
        '  await page.goto("/");',
        '  await page.getByRole("button", { name: "Run" }).click();',
        '  await expect(page.getByText("Complete")).toBeVisible();',
        "});",
      ].join("\n"),
    });

    await expect(
      inspectValidationQuality(
        workspace.root,
        [{ command: ["npx", "playwright", "test"], layer: "functional" }],
        {
          concerns: ["user-interaction"],
          validationFiles: ["tests/ui.spec.mjs"],
          scenarioIds: ["SCN001"],
        },
      ),
    ).resolves.toEqual([]);
  });

  it("inspects an explicitly declared browser helper without requiring a test-like filename", async () => {
    workspace = await TestWorkspace.create({
      "scripts/layout-contract.mjs": [
        "await page.setViewportSize({ width: 390, height: 844 });",
        'await page.goto("/");',
        'await page.getByRole("button").click();',
        "const scrollWidth = document.documentElement.scrollWidth;",
        "const clientWidth = document.documentElement.clientWidth;",
        "expect(scrollWidth).toBeLessThanOrEqual(clientWidth);",
        'await expect(page.getByRole("button")).toBeVisible();',
      ].join("\n"),
    });

    await expect(
      inspectValidationQuality(
        workspace.root,
        [{ command: ["npx", "playwright", "test"], layer: "functional" }],
        { concerns: ["visible-output"], validationFiles: ["scripts/layout-contract.mjs"] },
      ),
    ).resolves.toEqual([]);
  });

  it("rejects a named-test selector when the file contains only top-level assertions", async () => {
    workspace = await TestWorkspace.create({
      "tests/policy.test.mjs": [
        'import assert from "node:assert/strict";',
        "assert.equal(1 + 1, 2);",
        "",
      ].join("\n"),
    });

    const findings = await inspectValidationQuality(workspace.root, [
      {
        command: ["node", "--test", "--test-name-pattern=preserves order", "tests/policy.test.mjs"],
        layer: "unit",
      },
    ]);

    expect(findings.map((finding) => finding.code)).toContain("validation-selector-no-named-tests");
  });

  it("accepts a selector that matches an explicitly named test", async () => {
    workspace = await TestWorkspace.create({
      "tests/policy.test.mjs": [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'test("preserves order", () => assert.equal(1 + 1, 2));',
        "",
      ].join("\n"),
    });

    await expect(
      inspectValidationQuality(workspace.root, [
        {
          command: [
            "node",
            "--test",
            "--test-name-pattern=preserves order",
            "tests/policy.test.mjs",
          ],
          layer: "unit",
        },
      ]),
    ).resolves.toEqual([]);
  });
});
