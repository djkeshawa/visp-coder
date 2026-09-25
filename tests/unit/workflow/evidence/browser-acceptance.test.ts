import { afterEach, describe, expect, it } from "vitest";
import { inspectValidationQuality } from "../../../../src/workflow/evidence/test-quality.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace;
afterEach(async () => workspace?.destroy());

async function inspect(body: string, name = "AC001 save", args: string[] = []) {
  workspace = await TestWorkspace.create({
    "tests/browser.mjs": `import { test } from 'node:test';
      import assert from 'node:assert/strict';
      test(${JSON.stringify(name)}, async () => { await page.goto('/'); ${body} });`,
  });
  return inspectValidationQuality(
    workspace.root,
    [{ command: ["node", "--test", "tests/browser.mjs", ...args], layer: "functional" }],
    { acceptanceCriterion: "AC001" },
  );
}

describe("mandatory browser acceptance evidence", () => {
  it("does not accept a DOM counter as evidence for a canvas output contract", async () => {
    workspace = await TestWorkspace.create({
      "tests/browser.mjs": `import { test } from 'node:test'; import assert from 'node:assert/strict';
      test('AC001 render', async () => { await page.goto('/'); await page.click('button'); assert.equal(await page.locator('#score').textContent(), '100'); });`,
    });
    const findings = await inspectValidationQuality(
      workspace.root,
      [{ command: "node --test tests/browser.mjs", layer: "static" }],
      { acceptanceCriterion: "AC001", outputSurface: "canvas" },
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-browser-output-surface-unestablished",
        severity: "error",
      }),
    );
  });
  it("recognizes an asserted post-input pixel measurement from the imported canvas adapter", async () => {
    workspace = await TestWorkspace.create({
      "tests/browser.mjs": `import { test } from 'node:test'; import assert from 'node:assert/strict';
      import { measureCanvasRegion } from 'visp-coder/testing';
      test('AC001 render', async () => { await page.goto('/'); await page.click('button');
        const pixels = await page.evaluate(measureCanvasRegion, { selector: '#scene', x: 0, y: 0, width: 10, height: 10, color: [0,255,0,255] });
        assert.equal(pixels.matchingRatio, 1); });`,
    });
    const findings = await inspectValidationQuality(
      workspace.root,
      [{ command: "node --test tests/browser.mjs", layer: "functional" }],
      { acceptanceCriterion: "AC001", outputSurface: "canvas" },
    );
    expect(findings).toEqual([]);
  });
  it("does not let a different case name or command alias claim the criterion", async () => {
    expect(
      await inspect(
        "await page.click('button'); assert.equal(await page.title(), 'Saved');",
        "AC002 other",
        ["launch"],
      ),
    ).toContainEqual(
      expect.objectContaining({ code: "validation-browser-criterion-untraced", severity: "error" }),
    );
  });

  it.each([
    "await page.evaluate(() => document.querySelector('button').click());",
    "await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' })));",
    "await page.dispatchEvent('button', 'click');",
    "await page.locator('button').click({ force: true });",
    "page.click('button');",
  ])("rejects synthetic or forced input as journey evidence: %s", async (action) => {
    const findings = await inspect(`${action} assert.equal(await page.title(), 'Saved');`);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-input-bypass", severity: "error" }),
    );
  });

  it("does not mistake unrelated preconditions for a post-action outcome", async () => {
    const findings = await inspect(
      "await page.click('button'); assert.equal(await page.getAttribute('button', 'type'), 'button');",
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-browser-outcome-unestablished",
        severity: "error",
      }),
    );
  });

  it("rejects an internal calculation probe as browser outcome evidence", async () => {
    const findings = await inspect(
      "await page.click('button'); assert.equal(await page.evaluate(() => window.__APP_TEST__.fixedStepProbe().same), true);",
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "validation-browser-outcome-unestablished",
        severity: "error",
      }),
    );
  });

  it("accepts inspectable real input followed by a rendered outcome assertion", async () => {
    expect(
      await inspect(
        "await page.keyboard.press('Space'); assert.equal(await page.locator('#phase').textContent(), 'saved');",
      ),
    ).toEqual([]);
  });
  it.each([
    "const before = await page.title(); await page.click('button'); assert.equal(before, 'Saved');",
    "await page.click('button'); await page.title(); assert.equal(2, 2);",
    "await page.click('button'); expect(await page.title());",
    "await page.click('button'); expect(page.locator('#phase')).toHaveText('Saved');",
    "await page.click('button'); assert.ok(page.title());",
  ])("requires an asserted post-action result, not incidental reads: %s", async (body) => {
    expect(await inspect(body)).toContainEqual(
      expect.objectContaining({ code: "validation-browser-outcome-unestablished" }),
    );
  });

  it("does not borrow coverage from a skipped or unselected case", async () => {
    expect(
      await inspect(
        "await page.click('button'); assert.equal(await page.title(), 'Saved');",
        "AC001 save",
        ["--test-name-pattern=AC002"],
      ),
    ).toContainEqual(expect.objectContaining({ code: "validation-browser-criterion-untraced" }));
  });
  it("recognizes imported VISP helpers without trusting same-named local functions", async () => {
    workspace = await TestWorkspace.create({
      "tests/browser.mjs": `import { test } from 'node:test';
      import { activateControl as activate, assertUiState } from 'visp-coder/testing';
      test('AC001 reset UI', async () => {
        await page.goto('/'); await activate(page, '#reset', 'keyboard', 5, 'Space');
        await assertUiState(page, { name:'ready', viewport:{width:390,height:844}, controls:[{selector:'#reset'}] });
        assert.equal(await page.locator('#phase').textContent(), 'ready');
      });`,
    });
    const checks = [
      { command: ["node", "--test", "tests/browser.mjs"], layer: "functional" as const },
    ];
    expect(
      await inspectValidationQuality(workspace.root, checks, { acceptanceCriterion: "AC001" }),
    ).toEqual([]);
    const source = await (await workspace.state()).files.readText("tests/browser.mjs");
    if (!source.ok) throw new Error(source.error.message);
    await workspace.write(
      "tests/browser.mjs",
      source.value.replace("await assertUiState", "assertUiState"),
    );
    expect(
      await inspectValidationQuality(workspace.root, checks, {
        acceptanceCriterion: "AC001",
        concerns: ["visible-output"],
      }),
    ).toContainEqual(expect.objectContaining({ code: "validation-browser-contract-incomplete" }));
    await workspace.write(
      "tests/browser.mjs",
      `import {test} from 'node:test';
      function activateControl(){}; function assertUiState(){};
      test('AC001 fake', async()=>{await page.goto('/');activateControl();assertUiState();});`,
    );
    expect(
      (
        await inspectValidationQuality(workspace.root, checks, { acceptanceCriterion: "AC001" })
      ).some((f) => f.severity === "error"),
    ).toBe(true);
  });
});
