import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

test("the game is a direct-open, self-contained HTML page", () => {
  assert.match(html, /<canvas[^>]+id="game-canvas"/);
  assert.match(html, /id="reset-level"/);
  assert.match(html, /id="status"/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test("the browser script parses and wires real pointer input", () => {
  assert.doesNotThrow(() => new Function(inlineScript));
  assert.match(inlineScript, /pointerdown/);
  assert.match(inlineScript, /pointermove/);
  assert.match(inlineScript, /pointerup/);
  assert.match(inlineScript, /setPointerCapture/);
  assert.match(inlineScript, /launchShot/);
});

test("the game source includes score, collision and terminal recovery paths", () => {
  assert.match(inlineScript, /circleRectCollision/);
  assert.match(inlineScript, /Direct hit! \+250/);
  assert.match(inlineScript, /setGameState\("won"\)/);
  assert.match(inlineScript, /setGameState\("lost"\)/);
  assert.match(inlineScript, /Play again/);
  assert.match(html, /prefers-reduced-motion/);
});
