/** A bounded HTML token scanner, not a DOM or a JavaScript interpreter. */
export interface HtmlScript {
  readonly start: number;
  readonly end: number;
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, string>;
}

export function htmlScripts(source: string): HtmlScript[] {
  const result: HtmlScript[] = [];
  const tags = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let inert = 0;
  for (let match = tags.exec(source); match; match = tags.exec(source)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    const closing = match[0].startsWith("</");
    if (name === "template") {
      inert = templateDepth(inert, closing);
      continue;
    }
    if (
      closing ||
      ![
        "script",
        "style",
        "textarea",
        "title",
        "xmp",
        "iframe",
        "noembed",
        "noframes",
        "noscript",
        "plaintext",
      ].includes(name)
    )
      continue;
    const start = tags.lastIndex;
    const close = new RegExp(`</${name}\\s*>`, "gi");
    close.lastIndex = start;
    const end = rawTextEnd(name, close, source);
    tags.lastIndex = end ? close.lastIndex : source.length;
    if (name !== "script" || inert) continue;
    result.push({
      start,
      end: end?.index ?? source.length,
      tag: match[0],
      attributes: attributes(match[0]),
    });
  }
  return result;
}

function attributes(tag: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const body = tag.replace(/^<script\b/i, "").replace(/>$/, "");
  for (const match of body.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const key = (match[1] ?? "").toLowerCase();
    if (!result.has(key)) result.set(key, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

export function inlineJavaScript(source: string) {
  const scripts = htmlScripts(source).filter((script) => {
    const type = (script.attributes.get("type") ?? "").trim().toLowerCase();
    return (
      !script.attributes.has("src") &&
      [
        "",
        "module",
        "text/javascript",
        "application/javascript",
        "text/ecmascript",
        "application/ecmascript",
      ].includes(type)
    );
  });
  // Masking preserves the original page's line and column coordinates.
  let cursor = 0;
  const parts: string[] = [];
  for (const script of scripts) {
    parts.push(
      source.slice(cursor, script.start).replace(/[^\r\n]/g, " "),
      source.slice(script.start, script.end),
    );
    cursor = script.end;
    // A separator prevents adjacent script bodies being parsed as one expression.
    if (cursor < source.length) {
      parts.push(";");
      cursor++;
    }
  }
  parts.push(source.slice(cursor).replace(/[^\r\n]/g, " "));
  return { source: parts.join(""), scripts };
}

function templateDepth(depth: number, closing: boolean) {
  return Math.max(0, depth + (closing ? -1 : 1));
}

function rawTextEnd(name: string, close: RegExp, source: string) {
  return name === "plaintext" ? null : close.exec(source);
}
