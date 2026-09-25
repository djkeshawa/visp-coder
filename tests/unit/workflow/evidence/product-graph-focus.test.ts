import { afterEach, expect, it } from "vitest";
import { openStore } from "../../../../src/graph/index.js";
import { queryProductPaths } from "../../../../src/workflow/product/context-graph.js";
import { type Fixture, indexFixture, makeRepo } from "../../graph/fixtures.js";

let repo: Fixture | undefined;
afterEach(async () => repo?.cleanup());

it("finds a named change target beyond the first four scoped files and delivers its callers and tests", async () => {
  const noise = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`src/part${i}.ts`, `export const unrelated${i} = ${i};`]),
  );
  repo = await makeRepo({
    ...noise,
    "src/z-balance.ts": "export function computeBalance(value:number){return value;}",
    "src/api.ts":
      "import {computeBalance} from './z-balance.js'; export function getBalance(){return computeBalance(1);}",
    "tests/balance.test.ts":
      "import {test} from 'node:test'; import {computeBalance} from '../src/z-balance.js'; test('balance',()=>computeBalance(1));",
  });
  await indexFixture(repo);
  const opened = openStore(repo.storePath);
  if (!opened.ok) throw new Error(opened.error.message);
  const paths = [...Object.keys(noise), "src/z-balance.ts"];
  try {
    const context = queryProductPaths(opened.value, paths, "Fix computeBalance rounding");
    expect(context.graph.some((row) => row.name === "computeBalance")).toBe(true);
    expect(context.graph.some((row) => row.path === "src/api.ts")).toBe(true);
    expect(context.graph.some((row) => row.path === "tests/balance.test.ts")).toBe(true);
    expect(paths).toEqual([...Object.keys(noise), "src/z-balance.ts"]);
    expect(context.notes.join(" ")).toContain("4 of 7");
  } finally {
    opened.value.close();
  }
});

it("does not promote an unrelated out-of-scope symbol into the selected graph roots", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`src/part${i}.ts`, `export const unrelated${i} = ${i};`]),
  );
  repo = await makeRepo({
    ...files,
    "other/secret.ts": "export function computeBalance(){return 'private';}",
  });
  await indexFixture(repo);
  const opened = openStore(repo.storePath);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const context = queryProductPaths(opened.value, Object.keys(files), "Fix computeBalance");
    expect(context.graph.some((row) => row.path === "other/secret.ts")).toBe(false);
  } finally {
    opened.value.close();
  }
});

it("reports missing graph evidence without inventing results or changing requested roots", async () => {
  repo = await makeRepo();
  const opened = openStore(repo.storePath);
  if (!opened.ok) throw new Error(opened.error.message);
  const paths = Array.from({ length: 6 }, (_, index) => `src/part${index}.ts`);
  try {
    const context = queryProductPaths(opened.value, paths, "Fix computeBalance");
    expect(context.graph).toEqual([]);
    expect(context.notes.some((note) => /index|snapshot|graph/i.test(note))).toBe(true);
    expect(context.notes.join(" ")).toContain("4 of 6");
    expect(opened.value.requireHead().ok).toBe(false);
    expect(paths).toEqual(Array.from({ length: 6 }, (_, index) => `src/part${index}.ts`));
  } finally {
    opened.value.close();
  }
});

it("labels a bounded caller neighborhood as partial and permits a targeted follow-up", async () => {
  const callers = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `src/caller${index}.ts`,
      `import {computeBalance} from './balance.js'; export function caller${index}(){return computeBalance(${index});}`,
    ]),
  );
  repo = await makeRepo({
    "src/balance.ts": "export function computeBalance(value:number){return value;}",
    ...callers,
  });
  await indexFixture(repo);
  const opened = openStore(repo.storePath);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const context = queryProductPaths(opened.value, ["src/balance.ts"], "Fix computeBalance");
    expect(context.graph.some((row) => row.name === "computeBalance")).toBe(true);
    expect(context.notes).toContain(
      "Graph context is partial; use a targeted query for additional callers or tests.",
    );
    const omitted = Object.keys(callers).find(
      (path) => !context.graph.some((row) => row.path === path),
    );
    expect(omitted).toBeDefined();
    const followup = queryProductPaths(opened.value, [omitted as string]);
    expect(followup.graph.some((row) => row.path === omitted)).toBe(true);
  } finally {
    opened.value.close();
  }
});
