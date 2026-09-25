import { describe, expect, it } from "vitest";
import { z } from "zod";
import { guardInput } from "../../../src/mcp/tools/schemas.js";
import { controlExperimentSchema } from "../../../src/workflow/evidence/product-control.js";

describe("tool input schemas", () => {
  it("requires a nonempty control executable while preserving empty argv arguments", () => {
    const schema = controlExperimentSchema.shape.loadCommand;
    expect(schema.safeParse(["node", ""]).success).toBe(true);
    for (const invalid of [[], [""], ["", "test.mjs"], ["node", 2], "node"]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });
  it("requires at least one path for visp_guard", () => {
    const schema = z.object(guardInput);
    expect(schema.safeParse({ paths: ["src/a.ts"] }).success).toBe(true);
    expect(schema.safeParse({ paths: [] }).success).toBe(false);
    expect(schema.safeParse({ paths: [""] }).success).toBe(false);
    expect(schema.safeParse({ paths: "src/a.ts" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });
});
