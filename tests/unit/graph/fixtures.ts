import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig, type GraphConfig } from "../../../src/config/schema.js";
import { STATE_DIR } from "../../../src/core/constants.js";
import { readText } from "../../../src/core/fs.js";
import { type ExtractionOutcome, extractRepository } from "../../../src/graph/extract/index.js";
import { indexRepository } from "../../../src/graph/refresh.js";
import { openStore } from "../../../src/graph/store/index.js";
import type { GraphSnapshot } from "../../../src/graph/types.js";
import { walkRepository } from "../../../src/graph/walker/index.js";

/** A throwaway repository on disk. Tests build the smallest tree that shows the behaviour. */
export interface Fixture {
  readonly root: string;
  readonly storePath: string;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function makeRepo(files: Record<string, string> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "visp-graph-"));

  const fixture: Fixture = {
    root,
    // Inside the state directory the walker never descends into, as in a real project.
    storePath: join(root, STATE_DIR, "graph", "graph.db"),
    async write(path, content) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    },
    async remove(path) {
      await rm(join(root, path), { force: true });
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };

  for (const [path, content] of Object.entries(files)) await fixture.write(path, content);
  return fixture;
}

export function graphConfig(overrides: Partial<GraphConfig> = {}): GraphConfig {
  return { ...defaultConfig().graph, ...overrides };
}

/** Indexes a fixture and returns the published snapshot. */
export async function indexFixture(
  repo: Fixture,
  config: GraphConfig = graphConfig(),
): Promise<GraphSnapshot> {
  const indexed = await indexRepository(repo.root, config, repo.storePath);
  if (!indexed.ok) throw new Error(indexed.error.message);

  const store = openStore(repo.storePath);
  if (!store.ok) throw new Error(store.error.message);
  try {
    const head = store.value.requireHead();
    if (!head.ok) throw new Error(head.error.message);
    return head.value;
  } finally {
    store.value.close();
  }
}

/** Walks and extracts a fixture, failing loudly rather than returning half an answer. */
export async function extractFixture(
  repo: Fixture,
  config: GraphConfig = graphConfig(),
): Promise<ExtractionOutcome> {
  const walked = await walkRepository(repo.root, config);
  if (!walked.ok) throw new Error(walked.error.message);

  const extracted = await extractRepository({
    root: repo.root,
    files: walked.value.files,
    parseFiles: walked.value.files,
    skipped: walked.value.skipped,
    languages: config.languages,
    readSource: (path) => readText(join(repo.root, path)),
  });
  if (!extracted.ok) throw new Error(extracted.error.message);
  return extracted.value;
}

export const TS_SOURCES: Record<string, string> = {
  "src/math.ts": [
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export const double = (n: number): number => add(n, n);",
    "",
    "export interface Adder {",
    "  add(a: number, b: number): number;",
    "}",
    "",
    "export type Sum = number;",
    "",
    "export class Calculator {",
    "  total(values: number[]): number {",
    "    return values.reduce((a, b) => add(a, b), 0);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/app.ts": [
    'import { add, double } from "./math.js";',
    "",
    "export function run(): number {",
    "  return add(1, double(2));",
    "}",
    "",
  ].join("\n"),
  "tests/math.test.ts": [
    'import { describe, expect, it } from "vitest";',
    'import { add } from "../src/math.js";',
    "",
    'describe("add", () => {',
    '  it("adds", () => {',
    "    expect(add(1, 2)).toBe(3);",
    "  });",
    "});",
    "",
  ].join("\n"),
};
