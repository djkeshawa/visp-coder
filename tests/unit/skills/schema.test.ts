import { describe, expect, it } from "vitest";
import { validateSkillId } from "../../../src/skills/schema.js";

describe("validateSkillId", () => {
  it("accepts the ids allocated for skill directories", () => {
    const result = validateSkillId("regenerate-client");

    expect(result).toEqual({ ok: true, value: "regenerate-client" });
  });

  it("rejects path traversal before a directory path can be built", () => {
    const result = validateSkillId("../../escaped-skill");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED");
    expect(result.error.message).toContain("Skill id");
  });
});
