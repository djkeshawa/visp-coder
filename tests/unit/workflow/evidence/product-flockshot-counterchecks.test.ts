import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const fixture = new URL("../../../fixtures/product-quality/flockshot/", import.meta.url);
interface State {
  phase: string;
  reducedMotion: boolean;
  score: number;
  bird: { position: { x: number; y: number }; velocity: { x: number; y: number } };
  targets: object[];
  blocks: {
    x: number;
    y: number;
    width: number;
    height: number;
    material: string;
    health: number;
    maxHealth: number;
    alive: boolean;
    angle: number;
  }[];
}
interface Game {
  createState(): State;
  reset(state: State): void;
  nextLevel(state: State): void;
  step(state: State, delta: number): void;
}
async function game(): Promise<Game> {
  const sandbox = { module: { exports: {} }, Math };
  vm.runInNewContext(await readFile(new URL("game.js", fixture), "utf8"), sandbox, {
    timeout: 1000,
  });
  return sandbox.module.exports as Game;
}
describe("audited game qualification counterchecks", () => {
  it("reproduces all six weak-test passes on unchanged source", async () => {
    const root = await mkdtemp(join(tmpdir(), "visp-flockshot-countercheck-"));
    try {
      await mkdir(join(root, "test"));
      for (const file of ["game.js", "index.html"])
        await copyFile(new URL(file, fixture), join(root, file));
      await copyFile(new URL("game.test.fixture", fixture), join(root, "test/game.test.mjs"));
      const result = await promisify(execFile)(process.execPath, ["--test", "test/game.test.mjs"], {
        cwd: root,
        timeout: 10000,
      });
      expect(result.stdout).toContain("pass 6");
      expect(result.stdout).toContain("fail 0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects off-center top collisions and lost motion preferences through executed behavior", async () => {
    const api = await game();
    const impact = (x: number) => {
      const state = api.createState();
      state.targets = [{ x: 990, y: 50, radius: 20, alive: true }];
      state.blocks = [
        {
          x: 744,
          y: 391,
          width: 171,
          height: 20,
          material: "wood",
          health: 6,
          maxHealth: 6,
          alive: true,
          angle: 0,
        },
      ];
      state.phase = "flying";
      state.bird.position = { x, y: 365 };
      state.bird.velocity = { x: 0, y: 200 };
      api.step(state, 0.025);
      return state;
    };
    const center = impact(829.5),
      edge = impact(770);
    expect(center.bird.velocity.y).toBeLessThan(0);
    expect(edge.blocks[0]?.health).toBeLessThan(6); // A real contact happened.
    expect(edge.bird.velocity.y < 0).toBe(false); // The same top-contact expectation catches the defect.
    for (const transition of [api.reset, api.nextLevel]) {
      const state = api.createState();
      state.phase = "won";
      state.reducedMotion = true;
      state.score = 500;
      transition(state);
      expect(state.score).toBe(500);
      expect(state.reducedMotion === true).toBe(false);
    }
  });
});
