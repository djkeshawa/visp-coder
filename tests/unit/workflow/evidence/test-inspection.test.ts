import { describe, expect, it } from "vitest";
import { parseCount } from "../../../../src/graph/extract/parser.js";
import {
  inspectTestSource,
  sourceEvidenceKind,
} from "../../../../src/workflow/evidence/test-inspection.js";

describe("bounded test syntax inspection", () => {
  it("leaves unsupported languages unassessed without invoking a parser", async () => {
    const before = parseCount();
    const inspection = await inspectTestSource("test_workflow.py", "assert saved()\n");
    expect(sourceEvidenceKind(inspection)).toBe("unassessed");
    expect(inspection.scopes).toEqual([]);
    expect(parseCount()).toBe(before);
  });

  it("enforces the source bound before parsing", async () => {
    const before = parseCount();
    const inspection = await inspectTestSource("test.mjs", " ".repeat(1_000_001));
    expect(inspection.uncertainty).toContain("source size");
    expect(parseCount()).toBe(before);
  });

  it("does not inspect a partially parsed file as an executable contract", async () => {
    const inspection = await inspectTestSource("test.mjs", "test('unfinished', () => {");
    expect(inspection.uncertainty).toContain("parsed completely");
    expect(inspection.scopes).toEqual([]);
  });

  it.each(["test.ts", "test.tsx", "test.mts"])("accepts supported syntax in %s", async (path) => {
    const inspection = await inspectTestSource(
      path,
      "const value: number = 2; assert.equal(value, 2);",
    );
    expect(inspection.uncertainty).toBeUndefined();
    expect(inspection.scopes).toHaveLength(1);
  });

  it("keeps computed test names unassessed", async () => {
    const inspection = await inspectTestSource(
      "test.mjs",
      "test(name, async () => { await page.click(); });",
    );
    expect(inspection.uncertainty).toContain("Dynamically registered");
    expect(inspection.scopes).toEqual([]);
  });

  it("resolves a uniquely declared top-level test callback", async () => {
    const inspection = await inspectTestSource(
      "test.mjs",
      `
      import { readCatalog } from './catalog.mjs';
      export function verifyCatalog() {
        assert.deepEqual(readCatalog(), ['entry']);
      }
      test('catalog retains its entry', verifyCatalog);
    `,
    );

    expect(inspection.uncertainty).toBeUndefined();
    expect(inspection.scopes).toHaveLength(1);
    expect(inspection.scopes[0]?.name).toBe("catalog retains its entry");
    expect(inspection.scopes[0]?.code).toContain("readCatalog()");
    expect(sourceEvidenceKind(inspection)).toBeUndefined();
  });

  it("does not lend setup from a sibling suite", async () => {
    const inspection = await inspectTestSource(
      "test.mjs",
      `
      test.describe('other', () => {
        test.beforeEach(async ({ page }) => { await page.goto('/'); });
      });
      test.describe('documents', () => {
        test('SCN001 saves', async ({ page }) => {
          await page.click();
          await expect(page.getByText('Saved')).toBeVisible();
        });
      });
    `,
    );
    expect(inspection.scopes[0]?.name).toBe("documents SCN001 saves");
    expect(inspection.scopes[0]?.code).not.toContain("goto");
    expect(inspection.scopes[0]?.indirect).toBe(false);
  });
});
