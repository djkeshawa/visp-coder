import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { LIMITS } from "../../core/constants.js";
import type { Grammar } from "../constants.js";

/**
 * Tree-sitter runs as a WASM module: the runtime and every grammar are loaded
 * once per process and reused. Parsing is pure — no repository code executes.
 */

type TreeSitterTree = { rootNode: SyntaxNode; delete(): void };

/** The subset of the tree-sitter node surface the extractors use. */
export interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly hasError: boolean;
  readonly isError: boolean;
  readonly isMissing?: boolean;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly namedChildren: (SyntaxNode | null)[];
  readonly children: (SyntaxNode | null)[];
  readonly parent: SyntaxNode | null;
  childForFieldName(field: string): SyntaxNode | null;
  descendantsOfType(types: string | string[]): (SyntaxNode | null)[];
}

interface TreeSitterModule {
  Parser: {
    init(options?: { locateFile: (file: string, folder: string) => string }): Promise<void>;
    new (): {
      setLanguage(language: unknown): unknown;
      parse(
        source: string,
        oldTree?: unknown,
        options?: { progressCallback?: (state: { currentOffset: number }) => void },
      ): TreeSitterTree | null;
    };
  };
  Language: { load(input: Uint8Array): Promise<unknown> };
}

export interface ParsedTree {
  readonly grammar: Grammar;
  readonly root: SyntaxNode;
  readonly hasError: boolean;
}

export type ParseOutcome =
  | {
      readonly kind: "parsed";
      readonly tree: ParsedTree;
      /**
       * Frees the tree's WASM memory. Every node in `tree` points into it, so
       * call this only once the caller has finished reading the tree.
       */
      readonly dispose: () => void;
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "failed"; readonly detail: string };

const require = createRequire(import.meta.url);
const WASM_DIR = dirname(require.resolve("@vscode/tree-sitter-wasm"));

let runtime: Promise<TreeSitterModule> | undefined;
const languages = new Map<Grammar, Promise<unknown>>();
const parsers = new Map<Grammar, InstanceType<TreeSitterModule["Parser"]>>();
let parseCounter = 0;

/** Parses recorded so far. Callers assert on this to prove a refresh reparsed nothing. */
export function parseCount(): number {
  return parseCounter;
}

export function resetParseCount(): void {
  parseCounter = 0;
}

/**
 * Parses source into a tree the caller owns.
 *
 * Trees are deliberately not cached. A tree lives in WASM memory that its nodes
 * point into, so a cache would have to free evicted trees while callers might
 * still hold nodes from them. Since each file is parsed once per run, a cache
 * would only ever hit on byte-identical files — not worth a use-after-free.
 */
export async function parseSource(grammar: Grammar, source: string): Promise<ParseOutcome> {
  let parser: InstanceType<TreeSitterModule["Parser"]>;
  try {
    parser = await parserFor(grammar);
  } catch (cause) {
    return { kind: "failed", detail: describe(cause) };
  }

  parseCounter += 1;
  const deadline = Date.now() + LIMITS.parseTimeoutMs;
  let raw: TreeSitterTree | null;
  try {
    raw = parser.parse(source, null, { progressCallback: () => Date.now() > deadline });
  } catch (cause) {
    return { kind: "failed", detail: describe(cause) };
  }
  if (raw === null) return { kind: "timeout" };

  const handle = raw;
  const tree: ParsedTree = { grammar, root: handle.rootNode, hasError: handle.rootNode.hasError };
  return { kind: "parsed", tree, dispose: () => handle.delete() };
}

async function parserFor(grammar: Grammar): Promise<InstanceType<TreeSitterModule["Parser"]>> {
  const existing = parsers.get(grammar);
  if (existing) return existing;

  const module = await loadRuntime();
  const parser = new module.Parser();
  parser.setLanguage(await loadLanguage(module, grammar));
  parsers.set(grammar, parser);
  return parser;
}

function loadRuntime(): Promise<TreeSitterModule> {
  if (!runtime) {
    const module = require("@vscode/tree-sitter-wasm") as TreeSitterModule;
    runtime = module.Parser.init({ locateFile: (file) => join(WASM_DIR, file) }).then(() => module);
  }
  return runtime;
}

function loadLanguage(module: TreeSitterModule, grammar: Grammar): Promise<unknown> {
  const existing = languages.get(grammar);
  if (existing) return existing;

  const loading = readFile(join(WASM_DIR, `tree-sitter-${grammar}.wasm`)).then((bytes) =>
    module.Language.load(new Uint8Array(bytes)),
  );
  languages.set(grammar, loading);
  return loading;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
