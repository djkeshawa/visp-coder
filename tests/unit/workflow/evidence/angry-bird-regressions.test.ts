import { afterEach, describe, expect, it } from "vitest";
import { withValidationSmoke } from "../../../../src/doctor/validation.js";
import {
  inspectTestSource,
  sourceEvidenceKind,
} from "../../../../src/workflow/evidence/test-inspection.js";
import { inspectValidationQuality } from "../../../../src/workflow/evidence/test-quality.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

const sourceOnly = `import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
assert.ok(readFileSync('index.html', 'utf8').includes('Ready'));
`;

describe("browser game audit regressions", () => {
  it("inspects browser claims with omitted concerns and an ignored browser flag", async () => {
    workspace = await TestWorkspace.create({ "tests/game.test.mjs": sourceOnly });
    const findings = await inspectValidationQuality(
      workspace.root,
      [
        {
          command: ["node", "tests/game.test.mjs", "--case", "browser-contract", "--browser"],
          layer: "functional",
        },
      ],
      { concerns: [], scenarioIds: ["SCN001"], requiredLayers: ["functional"] },
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-browser-path-unassessed", severity: "warning" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-layer-static-only", severity: "error" }),
    );
  });

  it("inspects ordinary functional source checks without browser naming", async () => {
    workspace = await TestWorkspace.create({ "scripts/layout.mjs": sourceOnly });
    const findings = await inspectValidationQuality(workspace.root, [
      {
        command: ["node", "scripts/layout.mjs"],
        layer: "functional",
      },
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "validation-layer-static-only", severity: "error" }),
    );
  });

  it("does not infer a browser from generic functional or e2e command names", async () => {
    workspace = await TestWorkspace.create({
      "tests/functional.test.mjs": "assert.equal(runCli(), 'saved');",
    });
    const findings = await inspectValidationQuality(workspace.root, [
      {
        command: ["node", "tests/functional.test.mjs", "--case", "e2e"],
        layer: "functional",
      },
    ]);
    expect(findings).toEqual([]);
  });

  it.each(["./game.test.mjs", "../tests/game.test.mjs"])(
    "does not count the test's own import %s as implementation",
    async (self) => {
      const inspected = await inspectTestSource(
        "tests/game.test.mjs",
        `${sourceOnly}import * as self from '${self}'; self.check();`,
      );
      expect(inspected.projectBindings).toEqual([]);
      expect(sourceEvidenceKind(inspected)).toBe("unassessed");
    },
  );

  it("recognizes module._compile as dynamic execution, like the VM it replaced", async () => {
    const inspected = await inspectTestSource(
      "tests/game.test.mjs",
      sourceOnly +
        `
      import * as self from './game.test.mjs';
      require.extensions['.html'] = (module, filename) => module._compile(readFileSync(filename, 'utf8'), filename);
      self.loadGameApi();
    `,
    );
    expect(inspected.hasDynamicExecutor).toBe(true);
    expect(sourceEvidenceKind(inspected)).toBe("unassessed");
  });

  it.each(["./helper.mjs", "../src/missing.mjs"])(
    "does not credit an implementation call through %s",
    async (importPath) => {
      workspace = await TestWorkspace.create({
        "tests/game.test.mjs": `${sourceOnly}import { play } from '${importPath}'; play();`,
        "tests/helper.mjs": "export function play() {}",
      });
      const findings = await inspectValidationQuality(
        workspace.root,
        [{ command: ["node", "tests/game.test.mjs"], layer: "unit" }],
        { requiredLayers: ["unit"] },
      );
      expect(findings).toContainEqual(
        expect.objectContaining({ code: "validation-layer-unestablished", severity: "error" }),
      );
    },
  );

  it.each(["../src/game", "../src/game.js"])(
    "resolves real TypeScript implementation at %s",
    async (importPath) => {
      workspace = await TestWorkspace.create({
        "tests/game.test.ts": `${sourceOnly}import { play } from '${importPath}'; assert.equal(play(), 1);`,
        "src/game.ts": "export function play() { return 1; }",
      });
      const findings = await inspectValidationQuality(
        workspace.root,
        [{ command: ["npx", "vitest", "run", "tests/game.test.ts"], layer: "unit" }],
        { requiredLayers: ["unit"] },
      );
      expect(findings).toEqual([]);
    },
  );

  it("does not count an unused function's import call as a running test", async () => {
    const inspected = await inspectTestSource(
      "tests/game.test.mjs",
      `${sourceOnly}
      import { play } from '../src/game.mjs';
      function neverCalled() { play(); }
    `,
    );
    expect(sourceEvidenceKind(inspected)).toBe("unassessed");
  });

  it("preflights evidence quality even when the smoke command exits zero", async () => {
    workspace = await TestWorkspace.create({
      "index.html": "Ready",
      "tests/layout.mjs": sourceOnly,
    });
    const report = await withValidationSmoke(
      { verdict: "healthy", checks: [] },
      "node tests/layout.mjs --browser",
      workspace.root,
    );
    expect(report.verdict).toBe("unhealthy");
    expect(report.checks[0]?.detail).toContain("functional evidence");
  });
});
