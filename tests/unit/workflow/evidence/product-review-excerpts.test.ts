import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { reviewExcerpt } from "../../../../src/workflow/product/review-excerpts.js";

const fixture = new URL("../../../fixtures/product-quality/flockshot/", import.meta.url);
describe("behavior-focused source delivery", () => {
  it("keeps a complete relevant function and exact omission ranges under a tight budget", async () => {
    const source = [
      "function alpha() {",
      "  return 1;",
      "}",
      "",
      "function beta() {",
      "  return 2;",
      "}",
    ].join("\n");
    expect(await reviewExcerpt("game.js", source, "beta", 50)).toEqual({
      excerpt: "…\n5: function beta() {\n6:   return 2;\n7: }",
      omitted: ["1-4: source outside selected regions"],
    });
  });

  it("discloses unselected source even when every recognized function fits", async () => {
    const source = `${"const setting = 1;\n".repeat(100)}function reset() { return 0; }`;
    const result = await reviewExcerpt("game.js", source, "reset", 100);
    expect(result.excerpt).toContain("function reset");
    expect(result.excerpt.length).toBeLessThanOrEqual(100);
    expect(result.omitted).toContain("1-100: source outside selected regions");
  });

  it("does not report nested regions as omitted when their enclosing function was delivered", async () => {
    const source = `${"// setup\n".repeat(100)}function reset() {\n  const next = () => 0;\n  return next();\n}`;
    const result = await reviewExcerpt("game.js", source, "reset", 150);
    expect(result.excerpt).toContain("const next = () => 0");
    expect(result.omitted).toEqual(["1-100: source outside selected regions"]);
  });

  it("finds collision and reset behavior on the real game before there are prior findings", async () => {
    const brief = parse(await readFile(new URL("brief.yaml", fixture), "utf8"));
    const question = [
      brief.originalRequest,
      ...brief.outcomes.map((o: { statement: string }) => o.statement),
      ...brief.examples.flatMap((e: { title: string; when: string; expected: string[] }) => [
        e.title,
        e.when,
        ...e.expected,
      ]),
    ].join(" ");
    const source = await readFile(new URL("game.js", fixture), "utf8");
    const result = await reviewExcerpt("game.js", source, question);
    expect(result.excerpt).toContain("function hitBlocks");
    expect(result.excerpt).toContain("bird.velocity.x *= -0.58");
    expect(result.excerpt).toContain("function reset");
    expect(result.excerpt).toContain("Object.assign(state, fresh)");
    expect(result.excerpt.length).toBeLessThanOrEqual(6000);
    expect(result.omitted.length).toBeGreaterThan(0);
  });
  it("delivers complete meaningful assertions and discloses omitted tests under a tight budget", async () => {
    const source = await readFile(new URL("game.test.fixture", fixture), "utf8");
    const result = await reviewExcerpt(
      "test/game.test.mjs",
      source,
      "target collision score reset cleared levels progression",
      1800,
    );
    expect(result.excerpt).toContain("target impact awards points");
    expect(result.excerpt).toContain("assert.equal(target.alive, false)");
    expect(result.excerpt).toContain("cleared levels can advance");
    expect(result.excerpt).toContain("assert.equal(state.birdsLeft, state.maxBirds)");
    expect(result.excerpt).not.toContain("async function loadGameApi");
    expect(result.omitted.length).toBeGreaterThan(0);
  });
  it("delivers interactive HTML and responsive rules when scripts are external", async () => {
    const source = await readFile(new URL("index.html", fixture), "utf8");
    const result = await reviewExcerpt(
      "index.html",
      source,
      "canvas keyboard controls reduced motion responsive reset",
    );
    expect(result.excerpt).toContain('id="game"');
    expect(result.excerpt).toContain("prefers-reduced-motion");
    expect(result.excerpt).toContain('id="reset-game"');
    expect(result.excerpt.length).toBeLessThanOrEqual(6000);
  });
  it("retains Python test bodies, small sources, and explicit fallback gaps", async () => {
    const source = `${"# boilerplate\n".repeat(300)}def helper():\n    return 1\n\ndef test_reset():\n    result = reset()\n    assert result == 0\n`;
    const result = await reviewExcerpt("test_game.py", source, "reset", 300);
    expect(result.excerpt).toContain("def test_reset");
    expect(result.excerpt).toContain("assert result == 0");
    expect(await reviewExcerpt("a.js", "export const value = 1", "", 100)).toEqual({
      excerpt: "export const value = 1",
      omitted: [],
    });
    expect(
      (await reviewExcerpt("data.txt", "x".repeat(500), "", 100)).omitted.length,
    ).toBeGreaterThan(0);
  });
});
