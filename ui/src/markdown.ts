import { h } from "./dom.js";

/**
 * Renders the Markdown `visp pr` produces: headings, paragraphs, lists, tables,
 * quotes and code. Everything becomes text nodes; raw HTML in the source is
 * shown as the characters it is, never parsed.
 */
export function renderMarkdown(source: string): HTMLElement {
  const root = h("div", { class: "markdown" });
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index++;
      continue;
    }
    const block = readBlock(lines, index);
    root.appendChild(block.element);
    index = block.next;
  }
  return root;
}

interface Block {
  readonly element: HTMLElement;
  readonly next: number;
}

function readBlock(lines: readonly string[], start: number): Block {
  const line = lines[start] ?? "";
  if (line.startsWith("```")) return fence(lines, start);
  const heading = /^(#{1,4})\s+(.*)$/.exec(line);
  if (heading) {
    const level = Math.min((heading[1]?.length ?? 1) + 1, 5);
    const tag = `h${level}` as "h2" | "h3" | "h4" | "h5";
    return { element: h(tag, null, inline(heading[2] ?? "")), next: start + 1 };
  }
  if (/^\s*\|/.test(line)) return table(lines, start);
  if (/^\s*[-*]\s+/.test(line)) return list(lines, start, false);
  if (/^\s*\d+\.\s+/.test(line)) return list(lines, start, true);
  if (line.startsWith(">")) return quote(lines, start);
  return paragraph(lines, start);
}

function fence(lines: readonly string[], start: number): Block {
  const body: string[] = [];
  let index = start + 1;
  while (index < lines.length && !(lines[index] ?? "").startsWith("```"))
    body.push(lines[index++] ?? "");
  return {
    element: h("pre", { class: "code-block" }, h("code", null, body.join("\n"))),
    next: index + 1,
  };
}

function table(lines: readonly string[], start: number): Block {
  const rows: string[][] = [];
  let index = start;
  while (index < lines.length && /^\s*\|/.test(lines[index] ?? "")) {
    const cells = (lines[index] ?? "")
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
    if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) rows.push(cells);
    index++;
  }
  const [head, ...body] = rows;
  return {
    element: h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        null,
        head
          ? h(
              "thead",
              null,
              h(
                "tr",
                null,
                head.map((cell) => h("th", { scope: "col" }, inline(cell))),
              ),
            )
          : null,
        h(
          "tbody",
          null,
          body.map((row) =>
            h(
              "tr",
              null,
              row.map((cell) => h("td", null, inline(cell))),
            ),
          ),
        ),
      ),
    ),
    next: index,
  };
}

function list(lines: readonly string[], start: number, ordered: boolean): Block {
  const pattern = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
  const items: HTMLElement[] = [];
  let index = start;
  while (index < lines.length) {
    const match = pattern.exec(lines[index] ?? "");
    if (match) {
      items.push(h("li", null, inline(match[1] ?? "")));
      index++;
    } else if (/^\s{2,}\S/.test(lines[index] ?? "") && items.length > 0) {
      items.at(-1)?.append(" ", ...inline((lines[index] ?? "").trim()));
      index++;
    } else break;
  }
  return { element: h(ordered ? "ol" : "ul", null, items), next: index };
}

function quote(lines: readonly string[], start: number): Block {
  const body: string[] = [];
  let index = start;
  while (index < lines.length && (lines[index] ?? "").startsWith(">"))
    body.push((lines[index++] ?? "").replace(/^>\s?/, ""));
  return { element: h("blockquote", null, inline(body.join(" "))), next: index };
}

function paragraph(lines: readonly string[], start: number): Block {
  const body: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || /^(#{1,4}\s|```|\s*\||\s*[-*]\s|\s*\d+\.\s|>)/.test(line)) break;
    body.push(line.trim());
    index++;
  }
  return { element: h("p", null, inline(body.join(" "))), next: index };
}

/** `code` and **strong** only; everything else stays literal. */
function inline(text: string): (string | HTMLElement)[] {
  const parts: (string | HTMLElement)[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      match[1] !== undefined ? h("code", null, match[1]) : h("strong", null, match[2] ?? ""),
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
