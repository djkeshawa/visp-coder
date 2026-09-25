import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const requiredMarkers = [
  'id="game-shell"',
  'id="game-canvas"',
  'id="game-status"',
  'id="score-value"',
  'id="reset-level"',
  'id="next-level"',
  "Feather Fling",
  "prefers-reduced-motion"
];

for (const marker of requiredMarkers) {
  assert.ok(html.includes(marker), "missing required marker: " + marker);
}

assert.match(html, /<canvas[^>]+width="1280"[^>]+height="720"/, "canvas should expose a stable logical size");
assert.doesNotMatch(html, /(?:src|href)="(?:https?:|\/\/)/i, "the game must not load remote assets");

const scriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
assert.ok(scriptMatch, "inline game script should exist");
new vm.Script(scriptMatch[1], { filename: "index.html:inline-game-script" });

console.log("Feather Fling smoke checks passed: local, inline, and syntactically valid.");
