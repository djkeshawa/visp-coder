import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collapseToFileGraph,
  coverageFor,
  entityRegions,
  type GraphProjection,
  projectGraph,
  reverseImportClosure,
  structuralDistances,
  structuralNeighbourhood,
} from "../../../../src/graph/projection.js";
import { type Fixture, indexFixture, makeRepo, TS_SOURCES } from "../fixtures.js";

let repo: Fixture;
let projection: GraphProjection;

beforeEach(async () => {
  repo = await makeRepo({
    ...TS_SOURCES,
    "src/lonely.ts": "export const lonely = 1;\n",
    "src/deep.ts": 'import { run } from "./app.js";\nexport const deep = () => run();\n',
    "src/vendor.ts": 'import { z } from "zod";\nexport const schema = z;\n',
    "notes.md": "# notes\n",
  });
  projection = projectGraph(await indexFixture(repo));
});

afterEach(async () => {
  await repo.cleanup();
});

describe("projectGraph", () => {
  it("returns columnar arrays of equal length with counts that agree", () => {
    expect(projection.nodes.ids).toHaveLength(projection.counts.nodes);
    expect(projection.nodes.paths).toHaveLength(projection.counts.nodes);
    expect(projection.edges.sources).toHaveLength(projection.counts.edges);
    expect(projection.edges.kinds).toHaveLength(projection.counts.edges);
    expect(projection.files.paths).toHaveLength(projection.counts.files);
  });
});

describe("collapseToFileGraph", () => {
  it("reduces entity edges to file dependency edges", () => {
    const graph = collapseToFileGraph(projection);

    expect(graph.dependencyEdges).toContainEqual({ from: "src/app.ts", to: "src/math.ts" });
    expect(graph.dependencyEdges.every((edge) => edge.from !== edge.to)).toBe(true);
  });

  it("separates test edges from dependency edges", () => {
    const graph = collapseToFileGraph(projection);

    expect(graph.testFiles).toContain("tests/math.test.ts");
    expect(graph.testEdges).toContainEqual({
      from: "src/math.ts",
      to: "tests/math.test.ts",
    });
  });

  it("lists external modules separately from repository files", () => {
    const graph = collapseToFileGraph(projection);
    expect(graph.externalDeps).toContainEqual({ from: "src/vendor.ts", module: "zod" });
  });

  it("names files no parser covered", () => {
    const graph = collapseToFileGraph(projection);
    expect(graph.unparsedFiles).toContain("notes.md");
    expect(graph.unparsedFiles).not.toContain("src/app.ts");
  });
});

describe("reverseImportClosure", () => {
  it("walks a deterministic reverse closure through an import cycle", async () => {
    await repo.write("src/cycle-a.ts", 'import { b } from "./cycle-b.js";\nexport const a = b;\n');
    await repo.write("src/cycle-b.ts", 'import { a } from "./cycle-a.js";\nexport const b = a;\n');
    await repo.write(
      "src/cycle-consumer.ts",
      'import { a } from "./cycle-a.js";\nexport const result = a;\n',
    );
    const cycleProjection = projectGraph(await indexFixture(repo));

    const closure = reverseImportClosure(cycleProjection, ["src/cycle-b.ts", "src/cycle-a.ts"]);

    expect(closure).toEqual(["src/cycle-a.ts", "src/cycle-b.ts", "src/cycle-consumer.ts"]);
    expect(reverseImportClosure(cycleProjection, ["src/cycle-a.ts"])).toEqual(closure);
  });
});

/**
 * Built through the real extraction path rather than a hand-written edge list:
 * both earlier consumers of `testEdges` read the direction backwards, and every
 * hand-built fixture agreed with the consumer instead of the extractor.
 */
describe("coverageFor", () => {
  it("maps each module to the tests that cover it", () => {
    const coverage = coverageFor(collapseToFileGraph(projection), ["src/math.ts", "src/app.ts"]);

    expect(coverage["src/math.ts"]).toEqual(["tests/math.test.ts"]);
    expect(coverage["src/app.ts"]).toEqual([]);
  });

  it("does not key coverage by the test file", () => {
    const coverage = coverageFor(collapseToFileGraph(projection), ["tests/math.test.ts"]);

    expect(coverage["tests/math.test.ts"]).toEqual([]);
  });

  it("answers only for the paths it was asked about", () => {
    const coverage = coverageFor(collapseToFileGraph(projection), ["src/app.ts"]);

    expect(Object.keys(coverage)).toEqual(["src/app.ts"]);
  });
});

describe("structuralNeighbourhood", () => {
  it("returns seeds at hop zero and their neighbours in whole hops", () => {
    const result = structuralNeighbourhood(projection, ["src/app.ts"], 1, 50);
    const byPath = new Map(result.files.map((file) => [file.path, file.hops]));

    expect(byPath.get("src/app.ts")).toBe(0);
    expect(byPath.get("src/math.ts")).toBe(1);
    expect(byPath.get("src/deep.ts")).toBe(1);
    expect(byPath.has("tests/math.test.ts")).toBe(false);
  });

  it("reaches further as hops increase", () => {
    const result = structuralNeighbourhood(projection, ["src/deep.ts"], 2, 50);
    const byPath = new Map(result.files.map((file) => [file.path, file.hops]));

    expect(byPath.get("src/app.ts")).toBe(1);
    expect(byPath.get("src/math.ts")).toBe(2);
  });

  it("separates a seed the graph has never seen from one with no neighbours", () => {
    const result = structuralNeighbourhood(
      projection,
      ["src/lonely.ts", "src/never-existed.ts"],
      2,
      50,
    );

    expect(result.absentSeeds).toEqual(["src/never-existed.ts"]);
    expect(result.isolatedSeeds).toEqual(["src/lonely.ts"]);
    expect(result.files.map((file) => file.path)).toEqual(["src/lonely.ts"]);
  });

  it("caps the file count and says it was capped", () => {
    const result = structuralNeighbourhood(projection, ["src/app.ts"], 3, 2);

    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("is deterministic across runs", () => {
    const first = structuralNeighbourhood(projection, ["src/app.ts"], 3, 50);
    const second = structuralNeighbourhood(projection, ["src/app.ts"], 3, 50);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("structuralDistances", () => {
  it("reports the same hops the neighbourhood walk finds, without the cap", () => {
    const distances = structuralDistances(projection, ["src/app.ts"], 2);

    expect(distances.get("src/app.ts")).toBe(0);
    expect(distances.get("src/math.ts")).toBe(1);
    expect(distances.get("tests/math.test.ts")).toBe(2);
    expect(distances.has("src/lonely.ts")).toBe(false);
  });
});

describe("entityRegions", () => {
  it("names what the seed file reaches into a neighbour for, before its exports", () => {
    const regions = entityRegions(projection, ["src/app.ts"], ["src/math.ts"], 8);
    const labels = (regions["src/math.ts"] ?? []).map((region) => region.label);

    expect(labels).toContain("function add");
    expect(labels.some((label) => label.startsWith("exported "))).toBe(true);
    expect(labels.indexOf("function add")).toBeLessThan(
      labels.findIndex((label) => label.startsWith("exported ")),
    );
  });

  it("carries the entity's real span", () => {
    const regions = entityRegions(projection, ["src/app.ts"], ["src/math.ts"], 8);
    const add = (regions["src/math.ts"] ?? []).find((region) => region.label === "function add");

    expect(add?.startLine).toBe(1);
    expect(add?.endLine).toBe(3);
  });

  it("caps the regions per file", () => {
    const regions = entityRegions(projection, ["src/app.ts"], ["src/math.ts"], 2);
    expect(regions["src/math.ts"]).toHaveLength(2);
  });

  it("samples a large exported surface across the file instead of keeping only its head", async () => {
    await repo.write(
      "src/large.ts",
      Array.from(
        { length: 12 },
        (_, index) => `export function operation${index + 1}(): number { return ${index + 1}; }`,
      ).join("\n\n"),
    );
    const largeProjection = projectGraph(await indexFixture(repo));

    const regions = entityRegions(largeProjection, ["src/large.ts"], ["src/large.ts"], 4);
    const labels = (regions["src/large.ts"] ?? []).map((region) => region.label);

    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("operation1");
    expect(labels.at(-1)).toContain("operation12");
  });

  it("never labels a whole file as a region", () => {
    const regions = entityRegions(projection, ["src/app.ts"], ["src/math.ts"], 8);
    for (const region of regions["src/math.ts"] ?? []) {
      expect(region.label).not.toContain("file ");
    }
  });

  it("answers with an empty list for a file the graph has nothing on", () => {
    const regions = entityRegions(projection, ["src/app.ts"], ["notes.md"], 8);
    expect(regions["notes.md"]).toEqual([]);
  });
});
