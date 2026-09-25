interface XmlElement {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlElement[];
}

/** Small, non-expanding JUnit reader: external entities and DTDs are rejected. */
export function pytestJUnit(input: string): Record<string, unknown> {
  if (input.length > 16 * 1024 * 1024) throw new Error("JUnit report is too large");
  const root = parseXml(input);
  if (root.name !== "testsuites" && root.name !== "testsuite")
    throw new Error("JUnit requires a testsuite root");
  const cases: XmlElement[] = [];
  collectCases(root, cases);
  const tests = cases.map((test) => {
    const name = test.attributes.name;
    if (!name) throw new Error("JUnit testcase requires a name");
    const states = test.children.filter((child) =>
      ["failure", "error", "skipped"].includes(child.name),
    );
    const outcome = states.some((state) => state.name !== "skipped")
      ? "failed"
      : states.length
        ? "skipped"
        : "passed";
    return {
      nodeid: `${test.attributes.classname ?? test.attributes.file ?? "test"}::${name}`,
      outcome,
      ...(outcome === "passed" ? { call: { outcome: "passed" } } : {}),
    };
  });
  return {
    exitcode: tests.some((test) => test.outcome === "failed") ? 1 : 0,
    summary: { total: tests.length },
    tests,
  };
}

type JUnitCounters = Record<"tests" | "failures" | "errors" | "skipped", number>;

function collectCases(node: XmlElement, cases: XmlElement[]): JUnitCounters {
  const counters: JUnitCounters = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  if (node.name === "testcase") {
    cases.push(node);
    counters.tests = 1;
    counters.failures = Number(node.children.some((child) => child.name === "failure"));
    counters.errors = Number(node.children.some((child) => child.name === "error"));
    counters.skipped = Number(node.children.some((child) => child.name === "skipped"));
  } else {
    for (const child of node.children) {
      const nested = collectCases(child, cases);
      for (const key of Object.keys(counters) as Array<keyof JUnitCounters>)
        counters[key] += nested[key];
    }
  }
  if (node.name === "testsuite" || node.name === "testsuites")
    verifyCounters(node.attributes, counters);
  return counters;
}

function verifyCounters(attributes: Record<string, string>, counters: JUnitCounters): void {
  for (const key of Object.keys(counters) as Array<keyof JUnitCounters>) {
    const value = attributes[key];
    if (value === undefined) continue;
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) !== counters[key]
    )
      throw new Error(`JUnit ${key} counter disagrees`);
  }
}

function parseXml(input: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let cursor = 0;
  while (cursor < input.length) {
    const open = input.indexOf("<", cursor);
    xmlText(input.slice(cursor, open < 0 ? input.length : open), stack.length);
    if (open < 0) break;
    const section = xmlSection(input, open, Boolean(root), stack.length);
    if (section !== undefined) {
      cursor = section;
      continue;
    }
    const end = tagEnd(input, open);
    const tag = input.slice(open + 1, end).trim();
    cursor = end + 1;
    if (closeNode(stack, tag)) continue;
    const { node, selfClosing } = xmlNode(tag);
    root = attachNode(root, stack, node);
    pushNode(stack, node, selfClosing);
  }
  if (!root || stack.length) throw new Error("Incomplete JUnit XML");
  return root;
}

function closeNode(stack: XmlElement[], tag: string): boolean {
  if (!tag.startsWith("/")) return false;
  if (stack.pop()?.name !== tag.slice(1).trim()) throw new Error("Mismatched JUnit XML tag");
  return true;
}

function pushNode(stack: XmlElement[], node: XmlElement, selfClosing: boolean): void {
  if (!selfClosing) stack.push(node);
  if (stack.length > 64) throw new Error("JUnit XML nesting limit exceeded");
}

function xmlText(text: string, depth: number): void {
  if (!depth && text.trim()) throw new Error("Text outside JUnit root");
  decode(text);
}

function xmlSection(
  input: string,
  open: number,
  hasRoot: boolean,
  depth: number,
): number | undefined {
  if (input.startsWith("<!--", open)) return endOf(input, "-->", open + 4);
  if (input.startsWith("<![CDATA[", open) && depth) return endOf(input, "]]>", open + 9);
  if (input.startsWith("<?xml", open) && !hasRoot && !depth) return endOf(input, "?>", open + 5);
  if (input.startsWith("<!", open) || input.startsWith("<?", open))
    throw new Error("JUnit DTDs, entities, and processing instructions are unsupported");
  return undefined;
}

function tagEnd(input: string, open: number): number {
  let quote: string | undefined;
  for (let i = open + 1; i < input.length; i += 1) {
    const character = input[i];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return i;
  }
  throw new Error("Unterminated JUnit XML tag");
}

function xmlNode(tag: string): { node: XmlElement; selfClosing: boolean } {
  const selfClosing = tag.endsWith("/");
  const matched = /^([\w:.-]+)([\s\S]*)$/.exec(selfClosing ? tag.slice(0, -1).trim() : tag);
  if (!matched?.[1]) throw new Error("Invalid JUnit XML tag");
  return {
    node: { name: matched[1], attributes: attributes(matched[2] ?? ""), children: [] },
    selfClosing,
  };
}

function attachNode(
  root: XmlElement | undefined,
  stack: XmlElement[],
  node: XmlElement,
): XmlElement {
  const parent = stack.at(-1);
  if (parent) parent.children.push(node);
  else if (root) throw new Error("JUnit has multiple roots");
  return root ?? node;
}

function attributes(input: string): Record<string, string> {
  const values: Record<string, string> = {};
  let remaining = input.trim();
  while (remaining) {
    const match = /^([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/.exec(remaining);
    if (!match?.[1]) throw new Error("Invalid JUnit XML attribute");
    if (Object.hasOwn(values, match[1])) throw new Error("Duplicate JUnit XML attribute");
    values[match[1]] = decode(match[2] ?? match[3] ?? "");
    remaining = remaining.slice(match[0].length);
  }
  return values;
}

function decode(value: string): string {
  return value.replace(/&([^;\s]+);/g, (_match, entity: string) => {
    const known: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(known, entity)) return known[entity] ?? "";
    if (/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) {
      const point = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      if (point > 0 && point <= 0x10ffff) return String.fromCodePoint(point);
    }
    throw new Error("JUnit contains an unsupported XML entity");
  });
}

function endOf(input: string, marker: string, start: number): number {
  const index = input.indexOf(marker, start);
  if (index < 0) throw new Error("Unterminated JUnit XML section");
  return index + marker.length;
}
