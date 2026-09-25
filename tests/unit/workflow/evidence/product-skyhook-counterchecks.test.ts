import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { expect, it } from "vitest";

it("exposes missing support physics despite working collision damage in the interrupted Skyhook implementation", async () => {
  const html = await readFile(
    new URL("../../../fixtures/product-quality/skyhook-scramble/index.html", import.meta.url),
    "utf8",
  );
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Missing game source");
  const elements = new Map();
  const document = {
    querySelector(selector: string) {
      if (!elements.has(selector))
        elements.set(selector, {
          dataset: {},
          addEventListener() {},
          getContext() {
            return {};
          },
          classList: { toggle() {} },
        });
      return elements.get(selector);
    },
    querySelectorAll() {
      return [];
    },
  };
  const context = vm.createContext({
    document,
    window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
    localStorage: { getItem: () => "0", setItem() {} },
    performance: { now: () => 1000 },
    requestAnimationFrame() {},
    setTimeout() {},
  });
  // Expose the actual closure for a deterministic counterexperiment; do not replace game logic.
  vm.runInContext(
    script.replace(/\}\)\(\);\s*$/, "globalThis.subject = { game, hitBlocks, update }; })();"),
    context,
  );
  const result = vm.runInContext(
    `(() => {
    const {game, hitBlocks, update} = subject;
    game.muted = true;
    const support = game.blocks[0];
    game.bird = {x:support.x+10, y:support.y+10, r:23, vx:20, vy:0};
    hitBlocks();
    const broken = support.broken;
    const roof = game.blocks[2], target = game.targets[1];
    const before = {roofY:roof.y, targetY:target.y};
    game.mode = 'playing';
    for(let frame=0;frame<120;frame++) update(1);
    return {broken, before, after:{roofY:roof.y,targetY:target.y}};
  })()`,
    context,
  );
  expect(result.broken).toBe(true);
  expect(result.after).toEqual(result.before); // Actual defect: no gravity/support propagation.
});
