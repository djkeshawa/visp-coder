import type { SyntaxNode } from "./parser.js";

/** Tree-sitter's child accessors are nullable; these helpers keep that noise in one place. */

export function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

export function children(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter((child): child is SyntaxNode => child !== null);
}

export function field(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return node.childForFieldName(name) ?? undefined;
}

/** One-based line of a node's first character. */
export function lineOf(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

export function endLineOf(node: SyntaxNode): number {
  return node.endPosition.row + 1;
}

const QUOTE_PREFIX = /^[A-Za-z]*/;

/**
 * The literal value of a string node, or undefined when the value is computed.
 * A computed value is a fact we do not have, not a value to guess at.
 */
export function stringValue(node: SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (
    node.type === "template_string" &&
    named(node).some((c) => c.type === "template_substitution")
  )
    return undefined;
  if (!["string", "template_string", "concatenated_string"].includes(node.type)) return undefined;

  const text = node.text.replace(QUOTE_PREFIX, "");
  for (const quote of ['"""', "'''", '"', "'", "`"]) {
    if (text.length >= quote.length * 2 && text.startsWith(quote) && text.endsWith(quote)) {
      return text.slice(quote.length, text.length - quote.length);
    }
  }
  return undefined;
}

/** Depth-first pre-order over named nodes, with the visitor able to stop descent. */
export function walkNamed(root: SyntaxNode, visit: (node: SyntaxNode) => boolean): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (!visit(node)) continue;
    const kids = named(node);
    for (let index = kids.length - 1; index >= 0; index -= 1) {
      const kid = kids[index];
      if (kid) stack.push(kid);
    }
  }
}

/** Dotted text of a member/attribute expression, e.g. `app.get` or `click.command`. */
export function dottedName(node: SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "identifier") return node.text;
  if (node.type === "member_expression" || node.type === "attribute") {
    const object = dottedName(field(node, "object"));
    const property = field(node, "property")?.text ?? field(node, "attribute")?.text;
    if (object === undefined || property === undefined) return undefined;
    return `${object}.${property}`;
  }
  return undefined;
}

export function argumentsOf(call: SyntaxNode): SyntaxNode[] {
  const list = field(call, "arguments");
  return list ? named(list) : [];
}
