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

describe("bracket segments", () => {
  it("matches a framework route directory by its literal name", () => {
    expect(matchesPattern("app/[id]/page.tsx", "app/[id]/page.tsx")).toBe(true);
    expect(matchesPattern("app/[id]/page.tsx", "app/[id]/**")).toBe(true);
    expect(matchesPattern("app/[id]/nested/page.tsx", "app/[id]/**")).toBe(true);
  });

  it("keeps character-class semantics beside the literal spelling", () => {
    expect(matchesPattern("app/i/page.tsx", "app/[id]/page.tsx")).toBe(true);
    expect(matchesPattern("app/x/page.tsx", "app/[id]/page.tsx")).toBe(false);
    expect(matchesPattern("src/bx.ts", "src/[a-c]*.ts")).toBe(true);
    expect(matchesPattern("src/dx.ts", "src/[a-c]*.ts")).toBe(false);
    expect(matchesPattern("b.ts", "[!abc].ts")).toBe(false);
    expect(matchesPattern("d.ts", "[!abc].ts")).toBe(true);
  });

  it("matches catch-all and optional catch-all route names", () => {
    expect(matchesPattern("app/[...all]/page.tsx", "app/[...all]/page.tsx")).toBe(true);
    expect(matchesPattern("app/[[...slug]]/page.tsx", "app/[[...slug]]/page.tsx")).toBe(true);
    expect(matchesPattern("app/[[...slug]]/a/b.tsx", "app/[[...slug]]/**")).toBe(true);
    expect(matchesPattern("app/other/page.tsx", "app/[[...slug]]/**")).toBe(false);
  });

  it("does not throw on an invalid class and matches only the literal name", () => {
    expect(() => matchesPattern("[z-a].ts", "[z-a].ts")).not.toThrow();
    expect(matchesPattern("[z-a].ts", "[z-a].ts")).toBe(true);
    expect(matchesPattern("m.ts", "[z-a].ts")).toBe(false);
    expect(matchesPattern("[].ts", "[].ts")).toBe(true);
    expect(matchesPattern("a.ts", "[].ts")).toBe(false);
  });

  it("lets a forbidden bracket directory be named", () => {
    expect(firstMatch("app/[id]/secret.ts", ["docs/**", "app/[id]/**"])).toBe("app/[id]/**");
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
