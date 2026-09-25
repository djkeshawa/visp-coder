import { inlineJavaScript } from "../../graph/extract/html-scripts.js";
import { parseSource, type SyntaxNode } from "../../graph/extract/parser.js";
import { grammarForPath } from "../../graph/paths.js";

const stop = new Set(
  "the and with from this that have has for into when then should must user game state return function const false true null undefined string number".split(
    " ",
  ),
);
function words(text: string) {
  return new Set(
    (
      text
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[a-z][a-z0-9]{2,}/g) ?? []
    )
      .filter((word) => !stop.has(word))
      .map((word) => (word.length > 4 ? word.replace(/s$/, "") : word)),
  );
}
interface Region {
  start: number;
  end: number;
  name: string;
  text: string;
  test: boolean;
}
interface RankedRegion extends Region {
  names: string[];
  textScore: number;
  mutationScore: number;
}

/** Use the installed graph parser to retain whole behavior/test bodies where they fit. */
export async function reviewExcerpt(path: string, source: string, question: string, limit = 6000) {
  if (source.length <= limit) return { excerpt: source, omitted: [] as string[] };
  const regions = await sourceRegions(path, source);
  return selectRegions(source, regions, question, limit);
}

async function sourceRegions(path: string, source: string): Promise<Region[]> {
  const html = /\.html?$/i.test(path);
  const grammar = grammarForPath(path) ?? (html ? "javascript" : undefined);
  const parsed = grammar
    ? await parseSource(grammar, html ? inlineJavaScript(source).source : source)
    : undefined;
  const lines = source.split("\n");
  const regions: Region[] = [];
  if (parsed?.kind === "parsed") {
    try {
      for (const node of parsed.tree.root.descendantsOfType([
        "function_declaration",
        "function_definition",
        "method_definition",
        "arrow_function",
        "function_expression",
        "call_expression",
      ])) {
        const candidate = nodeRegion(node);
        if (candidate) regions.push(candidate);
      }
    } finally {
      parsed.dispose();
    }
  }
  if (html) regions.push(...htmlRegions(lines));
  return regions;
}

function htmlRegions(lines: string[]): Region[] {
  const regions: Region[] = [];
  for (const [index, line] of lines.entries()) {
    if (
      /<(?:canvas|button|input|form|main|section)\b/.test(line) ||
      /@media|\[hidden\]|:focus|touch-action|\.game-overlay/.test(line)
    )
      regions.push({
        start: index,
        end: Math.min(lines.length - 1, index + 5),
        name: line.trim().slice(0, 100),
        text: lines.slice(index, index + 6).join("\n"),
        test: false,
      });
  }
  return regions;
}

function selectRegions(source: string, regions: Region[], question: string, limit: number) {
  const lines = source.split("\n");
  const terms = words(question);
  const lowerQuestion = question.toLowerCase();
  const mentions = new Map(
    [...terms].map((word) => [
      word,
      Math.min(3, (lowerQuestion.match(new RegExp(`\\b${word}s?\\b`, "g")) ?? []).length || 1),
    ]),
  );
  const selected = selectLineIndexes(lines, rankRegions(regions, terms), mentions, limit);
  if (!selected.size)
    return {
      excerpt: source.slice(0, limit),
      omitted: ["No complete relevant region fits; inspect the source directly"],
    };
  const ordered = [...selected].sort((a, b) => a - b);
  return {
    excerpt: renderSelectedLines(ordered, lines),
    omitted: omittedLines(ordered, lines.length),
  };
}

function rankRegions(regions: Region[], terms: Set<string>): RankedRegion[] {
  // Lexical relevance is fixed for this request. Only name coverage changes as
  // regions are selected; do not repeatedly tokenize source inside the sort.
  return regions.map((item) => ({
    ...item,
    names: [...words(item.name)].filter((word) => terms.has(word)),
    textScore: [...words(item.text)].filter((word) => terms.has(word)).length * 0.3,
    mutationScore:
      Math.min(3, (item.text.match(/(?:\+=|-=|\*=|\/=|Object\.assign\()/g) ?? []).length) * 6,
  }));
}

function regionScore(
  item: RankedRegion,
  mentions: Map<string, number>,
  coveredNames: Set<string>,
): number {
  return (
    item.names.reduce(
      (sum, word) => sum + (mentions.get(word) ?? 1) * (coveredNames.has(word) ? 1 : 12),
      0,
    ) +
    item.textScore +
    item.mutationScore +
    (item.test ? 15 : 0)
  );
}

function selectLineIndexes(
  lines: string[],
  ranked: RankedRegion[],
  mentions: Map<string, number>,
  limit: number,
): Set<number> {
  let remaining = limit;
  const selected = new Set<number>();
  const coveredNames = new Set<string>();
  let rerank = true;
  while (ranked.length) {
    if (rerank)
      ranked.sort(
        (a, b) =>
          regionScore(b, mentions, coveredNames) - regionScore(a, mentions, coveredNames) ||
          a.start - b.start,
      );
    rerank = false;
    const item = ranked.shift();
    if (!item) break;
    const cost = incrementalRegionCost(item, lines, selected, remaining);
    if (cost > remaining) continue;
    for (let i = item.start; i <= item.end; i++) selected.add(i);
    remaining -= cost;
    rerank = addCoveredNames(item.names, coveredNames);
  }
  return selected;
}

function incrementalRegionCost(
  item: RankedRegion,
  lines: string[],
  selected: Set<number>,
  remaining: number,
): number {
  let cost = 2;
  for (let i = item.start; i <= item.end && cost <= remaining; i++) {
    if (!selected.has(i)) cost += (lines[i]?.length ?? 0) + String(i + 1).length + 4;
  }
  return cost;
}

function addCoveredNames(names: string[], coveredNames: Set<string>): boolean {
  let changed = false;
  for (const word of names) {
    if (!coveredNames.has(word)) changed = true;
    coveredNames.add(word);
  }
  return changed;
}

function renderSelectedLines(ordered: number[], lines: string[]): string {
  let previous = -1;
  return ordered
    .map((index) => {
      const prefix = index === previous + 1 ? "" : "…\n";
      previous = index;
      return `${prefix}${index + 1}: ${lines[index]}`;
    })
    .join("\n");
}

/** Disclose actual gaps, including top-level code the parser did not select. */
function omittedLines(selected: number[], lineCount: number): string[] {
  const omitted: string[] = [];
  let start = 0;
  for (const index of [...selected, lineCount]) {
    if (index > start) omitted.push(`${start + 1}-${index}: source outside selected regions`);
    start = index + 1;
  }
  return omitted.length > 6
    ? [...omitted.slice(0, 5), `${omitted.length - 5} further omitted ranges; inspect the source`]
    : omitted;
}

function nodeRegion(node: SyntaxNode | null): Region | undefined {
  if (!node) return undefined;
  if (node.type === "arrow_function" && node.parent?.type !== "variable_declarator")
    return undefined;
  const test =
    node.type === "call_expression" && /^(?:test|it|specify)(?:\.[\w]+)*\s*\(/.test(node.text);
  if (node.type === "call_expression" && !test) return undefined;
  // A test callback belongs to the containing test call, including its behavior name.
  if (
    !test &&
    node.parent?.type === "arguments" &&
    /^(test|it|specify)\b/.test(node.parent.parent?.text ?? "")
  )
    return undefined;
  const name = test
    ? (node.text.split("\n")[0] ?? "test")
    : (node.childForFieldName("name")?.text ?? node.text.split("\n")[0] ?? "function");
  return region(node, name, test);
}

function region(node: SyntaxNode, name: string, test: boolean): Region {
  return { start: node.startPosition.row, end: node.endPosition.row, text: node.text, name, test };
}
