import { describe, expect, it } from "vitest";
import { firstMatch, matchesAny, matchesPattern } from "../../../src/core/patterns.js";

describe("matchesPattern", () => {
  it("matches an exact path", () => {
    expect(matchesPattern("src/index.ts", "src/index.ts")).toBe(true);
    expect(matchesPattern("src/other.ts", "src/index.ts")).toBe(false);
  });

  it("treats a bare directory name as everything beneath it", () => {
    expect(matchesPattern("node_modules/pkg/index.js", "node_modules")).toBe(true);
    expect(matchesPattern("src/core/fs.ts", "src")).toBe(true);
    expect(matchesPattern("srcs/other.ts", "src")).toBe(false);
  });

  it("includes descendants of an explicit directory without including sibling paths", () => {
    expect(matchesPattern("src/main.mjs", "src/")).toBe(true);
    expect(matchesPattern("src/nested/main.mjs", "./src/")).toBe(true);
    expect(matchesPattern("src/main.mjs", "src\\")).toBe(true);
    expect(matchesPattern("srcs/main.mjs", "src/")).toBe(false);
    expect(matchesPattern("src", "src/")).toBe(false);
    expect(firstMatch("src/private/key.json", ["src/private/"])).toBe("src/private/");
  });

  it("keeps a single star inside one path segment", () => {
    expect(matchesPattern("src/index.ts", "src/*.ts")).toBe(true);
    expect(matchesPattern("src/core/index.ts", "src/*.ts")).toBe(false);
  });

  it("crosses segments with a globstar", () => {
    expect(matchesPattern("src/core/deep/file.ts", "src/**/*.ts")).toBe(true);
    expect(matchesPattern("src/file.ts", "src/**/*.ts")).toBe(true);
  });

  it("matches dotfile patterns such as .env.*", () => {
    expect(matchesPattern(".env.local", ".env.*")).toBe(true);
    expect(matchesPattern(".env", ".env")).toBe(true);
    expect(matchesPattern("config.env", ".env.*")).toBe(false);
  });

  it("matches a single character with ?", () => {
    expect(matchesPattern("a.ts", "?.ts")).toBe(true);
    expect(matchesPattern("ab.ts", "?.ts")).toBe(false);
  });

  it("normalizes a leading ./ and backslashes", () => {
    expect(matchesPattern("./src/index.ts", "src/index.ts")).toBe(true);
    expect(matchesPattern("src\\index.ts", "src/index.ts")).toBe(true);
  });

  it("treats regex metacharacters in a pattern as literals", () => {
    expect(matchesPattern("a+b.ts", "a+b.ts")).toBe(true);
    expect(matchesPattern("aab.ts", "a+b.ts")).toBe(false);
  });
});

describe("matchesAny and firstMatch", () => {
  const patterns = ["src/**/*.ts", "docs/*.md"];

  it("reports whether any pattern matches", () => {
    expect(matchesAny("src/core/fs.ts", patterns)).toBe(true);
    expect(matchesAny("tests/unit/a.ts", patterns)).toBe(false);
  });

  it("names the matching pattern so a refusal can explain itself", () => {
    expect(firstMatch("docs/readme.md", patterns)).toBe("docs/*.md");
    expect(firstMatch("tests/a.ts", patterns)).toBeUndefined();
  });
});
