/**
 * Span edits on JSONC: JSON with comments and trailing commas, which VS Code, Cursor and
 * OpenCode accept in their MCP configuration. Re-serializing such a file to add one server
 * loses every comment and the file's own layout, so these edits change only the bytes of the
 * one member they touch and leave the rest of the text as it was.
 *
 * Every function returns undefined when it cannot edit safely: a file it cannot read, a key
 * that appears twice, or a path through something that is not an object.
 */

interface JsoncMember {
  readonly key: string;
  readonly keyStart: number;
  readonly value: JsoncNode;
  /** The index of the comma after the value, when there is one. */
  readonly comma?: number;
}

type JsoncNode =
  | {
      readonly kind: "object";
      readonly start: number;
      readonly end: number;
      readonly members: JsoncMember[];
    }
  | { readonly kind: "value"; readonly start: number; readonly end: number };

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Sets `path` (object keys from the root) to `value`, creating missing objects on the way. */
export function setJsoncMember(
  source: string,
  path: readonly string[],
  value: unknown,
): string | undefined {
  const root = parseJsonc(source);
  if (root?.kind !== "object" || path.length === 0) return undefined;
  const layout = new Layout(source, root);
  let object = root;
  for (const [index, key] of path.entries()) {
    const found = memberNamed(object, key);
    if (found === "duplicate") return undefined;
    const rest = path.slice(index + 1);
    if (!found) return apply(source, layout.insert(object, key, nested(rest, value)));
    if (rest.length === 0) return apply(source, [layout.replace(object, found, value)]);
    if (found.value.kind !== "object") return undefined;
    object = found.value;
  }
  return undefined;
}

/** Removes the member at `path`, with its comma; the text is unchanged when it is absent. */
export function removeJsoncMember(source: string, path: readonly string[]): string | undefined {
  const root = parseJsonc(source);
  if (root?.kind !== "object" || path.length === 0) return undefined;
  let object = root;
  for (const key of path.slice(0, -1)) {
    const found = memberNamed(object, key);
    if (found === "duplicate") return undefined;
    if (!found) return source;
    if (found.value.kind !== "object") return undefined;
    object = found.value;
  }
  const found = memberNamed(object, path.at(-1) ?? "");
  if (found === "duplicate") return undefined;
  if (!found) return source;
  return apply(source, new Layout(source, root).remove(object, found));
}

function nested(path: readonly string[], value: unknown): unknown {
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
}

function memberNamed(
  object: Extract<JsoncNode, { kind: "object" }>,
  key: string,
): JsoncMember | "duplicate" | undefined {
  const matches = object.members.filter((member) => member.key === key);
  return matches.length > 1 ? "duplicate" : matches[0];
}

/** Applies edits from the end of the text backwards; of two at one place, the first listed comes first. */
function apply(source: string, edits: readonly Edit[]): string {
  let text = source;
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((left, right) => right.edit.start - left.edit.start || right.index - left.index);
  for (const { edit } of ordered)
    text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
  return text;
}

/** Where new text goes and how it is indented, following the file's own style. */
class Layout {
  private readonly newline: string;
  private readonly unit: string;
  /** The whole document is on one line, so nothing new spreads over several. */
  private readonly flat: boolean;

  constructor(
    private readonly source: string,
    root: Extract<JsoncNode, { kind: "object" }>,
  ) {
    this.newline = source.includes("\r\n") ? "\r\n" : "\n";
    this.unit = this.indentUnit(root) ?? "  ";
    this.flat = this.inline(root);
  }

  replace(
    object: Extract<JsoncNode, { kind: "object" }>,
    member: JsoncMember,
    value: unknown,
  ): Edit {
    return {
      start: member.value.start,
      end: member.value.end,
      text: this.render(value, this.memberIndent(object, member), this.inline(object)),
    };
  }

  insert(object: Extract<JsoncNode, { kind: "object" }>, key: string, value: unknown): Edit[] {
    const inline = this.inline(object);
    const last = object.members.at(-1);
    if (!last) return [this.insertIntoEmpty(object, key, value)];
    const indent = this.memberIndent(object, last);
    const text = `${JSON.stringify(key)}: ${this.render(value, indent, inline)}`;
    const trailing = last.comma !== undefined;
    const after = trailing ? (last.comma ?? 0) + 1 : last.value.end;
    const comma: Edit[] = trailing ? [] : [{ start: after, end: after, text: "," }];
    if (inline)
      return [...comma, { start: after, end: after, text: ` ${text}${trailing ? "," : ""}` }];
    const at = this.endOfLineTrivia(after);
    const member = `${this.newline}${indent}${text}${trailing ? "," : ""}`;
    if (at >= this.source.length || this.isNewline(at))
      return [...comma, { start: at, end: at, text: member }];
    // The object closes on the last member's line: the brace moves to a line of its own.
    const start = /^[ \t]*$/u.test(this.source.slice(after, at)) ? after : at;
    return [
      ...comma,
      { start, end: at, text: `${member}${this.newline}${this.lineIndent(object.start)}` },
    ];
  }

  remove(object: Extract<JsoncNode, { kind: "object" }>, member: JsoncMember): Edit[] {
    const index = object.members.indexOf(member);
    const previous = object.members[index - 1];
    const ownLine = !this.inline(object) && this.ownsLine(member.keyStart);
    const start = ownLine ? this.lineStart(member.keyStart) : member.keyStart;
    const tail = member.comma !== undefined ? member.comma + 1 : member.value.end;
    const lineEnd = this.endOfLineTrivia(tail);
    const end = ownLine && this.isNewline(lineEnd) ? this.afterNewline(lineEnd) : tail;
    // The last member has no comma of its own; the one before it then ends the object.
    const comma =
      member.comma === undefined && previous?.comma !== undefined
        ? [{ start: previous.comma, end: previous.comma + 1, text: "" }]
        : [];
    return [...comma, { start, end, text: "" }];
  }

  private insertIntoEmpty(
    object: Extract<JsoncNode, { kind: "object" }>,
    key: string,
    value: unknown,
  ): Edit {
    const inner = this.source.slice(object.start + 1, object.end - 1);
    const empty = inner.trim() === "";
    if (this.flat) {
      const text = `${JSON.stringify(key)}: ${this.render(value, "", true)}`;
      return empty
        ? { start: object.start + 1, end: object.end - 1, text }
        : { start: object.start + 1, end: object.start + 1, text: `${text} ` };
    }
    const outer = this.lineIndent(object.start);
    const indent = `${outer}${this.unit}`;
    const text = `${this.newline}${indent}${JSON.stringify(key)}: ${this.render(value, indent, false)}`;
    return empty
      ? { start: object.start + 1, end: object.end - 1, text: `${text}${this.newline}${outer}` }
      : { start: object.start + 1, end: object.start + 1, text };
  }

  private render(value: unknown, indent: string, inline: boolean): string {
    if (inline) return JSON.stringify(value);
    return JSON.stringify(value, null, this.unit).split("\n").join(`${this.newline}${indent}`);
  }

  /** An object written on one line gets compact members, as it has. */
  private inline(object: Extract<JsoncNode, { kind: "object" }>): boolean {
    return !this.source.slice(object.start, object.end).includes("\n");
  }

  private memberIndent(
    object: Extract<JsoncNode, { kind: "object" }>,
    member: JsoncMember,
  ): string {
    return this.ownsLine(member.keyStart)
      ? this.source.slice(this.lineStart(member.keyStart), member.keyStart)
      : `${this.lineIndent(object.start)}${this.unit}`;
  }

  /** The indentation step: a nested member's indent less its object's. */
  private indentUnit(object: Extract<JsoncNode, { kind: "object" }>): string | undefined {
    const outer = this.lineIndent(object.start);
    for (const member of object.members) {
      if (!this.ownsLine(member.keyStart)) continue;
      const indent = this.source.slice(this.lineStart(member.keyStart), member.keyStart);
      if (indent.startsWith(outer) && indent.length > outer.length)
        return indent.slice(outer.length);
    }
    for (const member of object.members) {
      if (member.value.kind !== "object") continue;
      const unit = this.indentUnit(member.value);
      if (unit) return unit;
    }
    return undefined;
  }

  /** Past spaces and comments that end on this line: where a line's own text stops. */
  private endOfLineTrivia(from: number): number {
    let at = from;
    for (;;) {
      while (this.source[at] === " " || this.source[at] === "\t") at++;
      if (this.source.startsWith("//", at)) return this.lineEnd(at);
      if (!this.source.startsWith("/*", at)) return at;
      const close = this.source.indexOf("*/", at + 2);
      if (close < 0 || this.source.slice(at, close).includes("\n")) return at;
      at = close + 2;
    }
  }

  /** Where the line holding `at` ends, before its `\r\n` or `\n`. */
  private lineEnd(at: number): number {
    const newline = this.source.indexOf("\n", at);
    if (newline < 0) return this.source.length;
    return this.source[newline - 1] === "\r" ? newline - 1 : newline;
  }

  private isNewline(at: number): boolean {
    return this.source[at] === "\n" || this.source.startsWith("\r\n", at);
  }

  private afterNewline(at: number): number {
    return at + (this.source.startsWith("\r\n", at) ? 2 : 1);
  }

  private lineStart(at: number): number {
    return this.source.lastIndexOf("\n", at - 1) + 1;
  }

  /** Whether only whitespace precedes `at` on its line. */
  private ownsLine(at: number): boolean {
    return /^[ \t]*$/u.test(this.source.slice(this.lineStart(at), at));
  }

  private lineIndent(at: number): string {
    return /^[ \t]*/u.exec(this.source.slice(this.lineStart(at), at))?.[0] ?? "";
  }
}

/** The spans of a JSONC document's values, or undefined when it is not one. */
function parseJsonc(source: string): JsoncNode | undefined {
  const reader = new Reader(source);
  try {
    const node = reader.value();
    reader.skip();
    return reader.done() ? node : undefined;
  } catch {
    return undefined;
  }
}

class Reader {
  private at = 0;

  constructor(private readonly source: string) {}

  done(): boolean {
    return this.at === this.source.length;
  }

  value(): JsoncNode {
    this.skip();
    const char = this.source[this.at];
    if (char === "{") return this.object();
    const start = this.at;
    if (char === "[") this.array();
    else if (char === '"') this.string();
    else {
      const literal = /^[A-Za-z0-9+\-.]+/u.exec(this.source.slice(this.at))?.[0];
      if (!literal) throw new Error("Unexpected JSONC text");
      this.at += literal.length;
    }
    return { kind: "value", start, end: this.at };
  }

  skip(): void {
    for (;;) {
      while (/\s/u.test(this.source[this.at] ?? "")) this.at++;
      if (this.source.startsWith("//", this.at)) {
        const newline = this.source.indexOf("\n", this.at);
        this.at = newline < 0 ? this.source.length : newline;
      } else if (this.source.startsWith("/*", this.at)) {
        const close = this.source.indexOf("*/", this.at + 2);
        if (close < 0) throw new Error("Unterminated comment");
        this.at = close + 2;
      } else return;
    }
  }

  private object(): JsoncNode {
    const start = this.at++;
    const members: JsoncMember[] = [];
    for (;;) {
      this.skip();
      if (this.source[this.at] === "}") return { kind: "object", start, end: ++this.at, members };
      if (this.source[this.at] !== '"') throw new Error("Expected a key");
      const keyStart = this.at;
      this.string();
      const key: unknown = JSON.parse(this.source.slice(keyStart, this.at));
      if (typeof key !== "string") throw new Error("Expected a key");
      this.skip();
      if (this.source[this.at++] !== ":") throw new Error("Expected a colon");
      const value = this.value();
      this.skip();
      if (this.source[this.at] === ",") {
        members.push({ key, keyStart, value, comma: this.at++ });
      } else {
        members.push({ key, keyStart, value });
        this.skip();
        if (this.source[this.at] !== "}") throw new Error("Expected a comma");
      }
    }
  }

  private array(): void {
    this.at++;
    for (;;) {
      this.skip();
      if (this.source[this.at] === "]") {
        this.at++;
        return;
      }
      this.value();
      this.skip();
      if (this.source[this.at] === ",") this.at++;
      else if (this.source[this.at] !== "]") throw new Error("Expected a comma");
    }
  }

  private string(): void {
    let at = this.at + 1;
    while (at < this.source.length && this.source[at] !== '"') {
      if (this.source[at] === "\n") break;
      at += this.source[at] === "\\" ? 2 : 1;
    }
    if (this.source[at] !== '"') throw new Error("Unterminated string");
    this.at = at + 1;
  }
}
