import {
  argumentsOf,
  dottedName,
  field,
  named,
  stringValue,
  walkNamed,
} from "../../graph/extract/nodes.js";
import type { SyntaxNode } from "../../graph/extract/parser.js";

const INPUT = /\.(?:click|dblclick|fill|press|type|dragTo|tap|check|uncheck|selectOption)$/;
const READ =
  /\.(?:title|textContent|innerText|inputValue|isVisible|isEnabled|isDisabled|count|boundingBox|getBoundingClientRect)$/;
const MATCHER =
  /\.(?:toHaveText|toContainText|toHaveValue|toHaveCount|toBeVisible|toBeHidden|toBeEnabled|toBeDisabled|toHaveScreenshot)$/;

export interface BrowserActions {
  readonly hasInput: boolean;
  readonly uiCheck: boolean;
  readonly inputBypass: boolean;
  readonly renderedOutcome: boolean;
  readonly pixelOutcome: boolean;
}

/** Conservative, local data flow. This rejects missing evidence; it cannot prove test semantics. */
export function inspectBrowserActions(
  root: SyntaxNode,
  helpers: ReadonlyMap<string, string>,
): BrowserActions {
  const calls: SyntaxNode[] = [];
  const declarations = new Map<string, SyntaxNode>();
  walkNamed(root, (node) => {
    if (["comment", "string", "template_string"].includes(node.type)) return false;
    if (node.type === "call_expression") calls.push(node);
    if (node.type === "variable_declarator") {
      const name = field(node, "name");
      const value = field(node, "value");
      if (name?.type === "identifier" && value) declarations.set(name.text, value);
    }
    return true;
  });
  const actions = calls.filter(
    (call) => INPUT.test(calleeName(call)) || helpers.get(calleeName(call)) === "activateControl",
  );
  const last = actions.at(-1);
  const inputBypass = calls.some((call) => {
    const callee = calleeName(call);
    return (
      /\.dispatchEvent$/.test(callee) ||
      (INPUT.test(callee) && (insideEvaluation(call) || forced(call) || !awaited(call))) ||
      (helpers.get(callee) === "activateControl" && !awaited(call))
    );
  });
  const renderedOutcome = hasOutcome(false);
  const pixelOutcome = hasOutcome(true);
  function hasOutcome(pixelOnly: boolean): boolean {
    return (
      last !== undefined &&
      calls.some((call) => {
        if (!afterAction(call)) return false;
        const callee = calleeName(call);
        if (helpers.get(callee) === "assertUiState") return !pixelOnly && awaited(call);
        if (MATCHER.test(callee))
          return (
            (!pixelOnly || callee.endsWith(".toHaveScreenshot")) &&
            expectationArgument(call) !== undefined &&
            awaited(call)
          );
        const actual = assertedArgument(call);
        return actual !== undefined && observed(actual, new Set(), pixelOnly);
      })
    );
  }
  return {
    inputBypass,
    renderedOutcome,
    pixelOutcome,
    hasInput: actions.length > 0,
    uiCheck: calls.some(
      (call) => helpers.get(calleeName(call)) === "assertUiState" && awaited(call),
    ),
  };

  function observed(node: SyntaxNode, seen: Set<string>, pixelOnly: boolean): boolean {
    if (node.type === "identifier") {
      return observedBinding(node.text, seen, pixelOnly);
    }
    if (["string", "template_string", "comment"].includes(node.type)) return false;
    const pixelRead = canvasRead(node, helpers);
    if (pixelRead !== undefined) return pixelRead;
    const read = browserRead(node);
    if (!pixelOnly && read !== undefined) return read;
    if (!pixelOnly && renderedProperty(node)) return true;
    return named(node).some((child) => observed(child, seen, pixelOnly));
  }
  function observedBinding(name: string, seen: Set<string>, pixelOnly: boolean): boolean {
    if (seen.has(name)) return false;
    seen.add(name);
    const value = declarations.get(name);
    return value !== undefined && afterAction(value) && observed(value, seen, pixelOnly);
  }
  function afterAction(node: SyntaxNode): boolean {
    return (
      last !== undefined &&
      (node.startPosition.row > last.endPosition.row ||
        (node.startPosition.row === last.endPosition.row &&
          node.startPosition.column > last.endPosition.column))
    );
  }
}

function assertedArgument(call: SyntaxNode): SyntaxNode | undefined {
  const callee = calleeName(call);
  if (/^assert(?:\.|$)/.test(callee)) return argumentsOf(call)[0];
  return /\.(?:toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toContain|toBeGreaterThan|toBeLessThan|toBeLessThanOrEqual|toBeGreaterThanOrEqual)$/.test(
    callee,
  )
    ? expectationArgument(call)
    : undefined;
}

function canvasRead(node: SyntaxNode, helpers: ReadonlyMap<string, string>): boolean | undefined {
  if (node.type !== "call_expression") return undefined;
  const callee = calleeName(node);
  if (/\.(?:evaluate|evaluateAll)$/.test(callee) && !awaited(node)) return false;
  const callback = argumentsOf(node)[0];
  return /\.evaluate$/.test(callee) &&
    callback &&
    helpers.get(callback.text) === "measureCanvasRegion"
    ? true
    : undefined;
}

function browserRead(node: SyntaxNode): boolean | undefined {
  if (node.type !== "call_expression") return undefined;
  if (/\.(?:evaluate|evaluateAll)$/.test(calleeName(node)) && !awaited(node)) return false;
  return READ.test(calleeName(node)) ? insideEvaluation(node) || awaited(node) : undefined;
}

function renderedProperty(node: SyntaxNode): boolean {
  return (
    node.type === "member_expression" &&
    /^(?:document|window\.document)\.title$|\.(?:textContent|innerText|value|disabled|scrollWidth|scrollHeight|clientWidth|clientHeight|innerWidth|innerHeight)$/.test(
      dottedName(node) ?? `.${field(node, "property")?.text}`,
    )
  );
}

function expectationArgument(call: SyntaxNode): SyntaxNode | undefined {
  let node = field(call, "function");
  while (node) {
    if (node.type === "call_expression" && calleeName(node) === "expect")
      return argumentsOf(node)[0];
    node = field(node, "object");
  }
  return undefined;
}

function awaited(call: SyntaxNode): boolean {
  let parent = call.parent;
  while (parent?.type === "parenthesized_expression") parent = parent.parent;
  return parent?.type === "await_expression" || parent?.type === "return_statement";
}

/** Only package imports get helper semantics; a local function with the same name proves nothing. */
export function testingHelpers(node: SyntaxNode): ReadonlyMap<string, string> {
  let root = node;
  while (root.parent) root = root.parent;
  const helpers = new Map<string, string>();
  for (const statement of named(root)) {
    if (
      statement.type !== "import_statement" ||
      stringValue(field(statement, "source")) !== "visp-coder/testing"
    )
      continue;
    walkNamed(statement, (entry) => {
      if (entry.type !== "import_specifier") return true;
      const imported = field(entry, "name")?.text;
      const local = (field(entry, "alias") ?? field(entry, "name"))?.text;
      if (
        imported &&
        local &&
        [
          "activateControl",
          "assertControlReachable",
          "assertUiState",
          "measureUiState",
          "measureControl",
          "measureCanvasRegion",
        ].includes(imported)
      )
        helpers.set(local, imported);
      return false;
    });
  }
  return helpers;
}

function calleeName(call: SyntaxNode): string {
  const callee = field(call, "function");
  return dottedName(callee) ?? `.${callee && field(callee, "property")?.text}`;
}

function insideEvaluation(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      parent.type === "call_expression" &&
      /\.(?:evaluate|evaluateAll)$/.test(dottedName(field(parent, "function")) ?? "")
    )
      return true;
  }
  return false;
}

function forced(call: SyntaxNode): boolean {
  let force = false;
  for (const argument of argumentsOf(call))
    walkNamed(argument, (node) => {
      if (
        node.type === "pair" &&
        field(node, "key")?.text === "force" &&
        field(node, "value")?.text === "true"
      )
        force = true;
      return true;
    });
  return force;
}
