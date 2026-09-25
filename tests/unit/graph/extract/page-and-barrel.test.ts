import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collapseToFileGraph,
  coverageFor,
  type GraphProjection,
  projectGraph,
  structuralNeighbourhood,
} from "../../../../src/graph/projection.js";
import type { GraphSnapshot } from "../../../../src/graph/types.js";
import { type Fixture, indexFixture, makeRepo } from "../fixtures.js";

/**
 * The browser-game shape every evaluation run had, and the graph's three
 * historic blind spots in it: the page's script tag (the real entrypoint),
 * calls through a barrel, and unknown lists drowned in runtime builtins.
 */

let repo: Fixture;
let snapshot: GraphSnapshot;
let projection: GraphProjection;

beforeAll(async () => {
  repo = await makeRepo({
    "index.html": [
      "<!doctype html>",
      '<script type="importmap">{"imports":{"three":"https://cdn.example/three.js"}}</script>',
      '<script type="module" src="./src/main.js"></script>',
    ].join("\n"),
    "src/main.js": [
      'import * as THREE from "three";',
      'import { start } from "./core/index.js";',
      "Math.floor(1.2);",
      "new THREE.Vector3();",
      "THREE.MathUtils.clamp(1, 0, 2);",
      "start();",
      "",
    ].join("\n"),
    "src/core/index.js": 'export { start } from "./engine.js";\n',
    "src/core/engine.js": "export function start() {\n  return 1;\n}\n",
    "tests/core.test.js": [
      'import { test } from "node:test";',
      'import { start } from "../src/core/index.js";',
      'test("starts", () => start());',
      "",
    ].join("\n"),
  });
  snapshot = await indexFixture(repo);
  projection = projectGraph(snapshot);
});

afterAll(async () => {
  await repo.cleanup();
});

describe("the page entry chain", () => {
  it("gives the application hub an inbound edge from the page", () => {
    const graph = collapseToFileGraph(projection);
    expect(graph.dependencyEdges).toContainEqual({ from: "index.html", to: "src/main.js" });
  });

  it("records the script tag as a page entrypoint", () => {
    const pages = snapshot.entrypoints.filter((entry) => entry.kind === "page_entrypoint");
    expect(pages.map((entry) => entry.name)).toContain("src/main.js");
    expect(pages[0]?.path).toBe("index.html");
  });

  it("records the import map's bare specifiers as external dependencies", () => {
    const graph = collapseToFileGraph(projection);
    expect(graph.externalDeps).toContainEqual({ from: "index.html", module: "three" });
  });

  it("lets a neighbourhood walk reach main from the page", () => {
    const near = structuralNeighbourhood(projection, ["src/main.js"], 1, 50);
    expect(near.files.map((file) => file.path)).toContain("index.html");
  });
});

describe("unknown noise", () => {
  it("does not report runtime globals as unresolved calls", () => {
    const details = snapshot.unknowns.map((unknown) => unknown.detail);
    expect(details).not.toContain("Math.floor");
  });

  it("does not report calls into a bound external module as unresolved", () => {
    const details = snapshot.unknowns.map((unknown) => unknown.detail ?? "");
    expect(details.some((detail) => detail.startsWith("THREE."))).toBe(false);
  });
});

describe("through the barrel", () => {
  it("resolves a call bound to a barrel one hop to the defining file", () => {
    const calls = snapshot.relations.filter(
      (relation) => relation.kind === "calls" && relation.path === "src/main.js",
    );
    expect(calls.map((relation) => relation.target)).toContain("src/core/engine.js#function:start");
  });

  it("credits a barrel-imported test to the module behind the barrel", () => {
    const coverage = coverageFor(collapseToFileGraph(projection), ["src/core/engine.js"]);
    expect(coverage["src/core/engine.js"]).toContain("tests/core.test.js");
  });
});
