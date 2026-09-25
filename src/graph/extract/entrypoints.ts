import { HTTP_METHOD_NAMES, TEST_DECLARING_CALLS, TEST_FRAMEWORK_MODULES } from "../constants.js";
import { basename } from "../paths.js";
import type { Entrypoint } from "../types.js";
import { argumentsOf, dottedName, field, lineOf, named, stringValue, walkNamed } from "./nodes.js";
import type { ParsedTree, SyntaxNode } from "./parser.js";

/**
 * Entrypoints are bound from evidence in the source, never from a filename. A
 * file called `cli.ts` is not a command; a `.command("build")` call is.
 */

const HTTP_METHODS = new Set<string>(HTTP_METHOD_NAMES);
const CLI_COMMAND_NAMES = new Set(["command", "group"]);
const TEST_FRAMEWORKS = new Set<string>(TEST_FRAMEWORK_MODULES);
const TEST_CALLS = new Set<string>(TEST_DECLARING_CALLS);

export interface EntrypointInput {
  readonly path: string;
  readonly tree: ParsedTree;
  readonly importedModules: readonly string[];
}

export function extractEntrypoints(input: EntrypointInput): Entrypoint[] {
  const found =
    input.tree.grammar === "python" ? pythonEntrypoints(input) : scriptEntrypoints(input);
  const test = testEntrypoint(input);
  if (test) found.push(test);
  return found;
}

function scriptEntrypoints(input: EntrypointInput): Entrypoint[] {
  const found: Entrypoint[] = [];
  walkNamed(input.tree.root, (node) => {
    if (node.type !== "call_expression") return true;
    const callee = dottedName(field(node, "function"));
    if (callee === undefined) return true;

    const args = argumentsOf(node);
    const literal = stringValue(args[0]);
    if (literal === undefined) return true;

    const method = lastSegment(callee);
    if (HTTP_METHODS.has(method) && literal.startsWith("/") && args.length >= 2) {
      found.push(entrypoint("http_route", input.path, literal, node, `${callee}("${literal}")`));
    } else if (CLI_COMMAND_NAMES.has(method)) {
      found.push(entrypoint("cli_command", input.path, literal, node, `${callee}("${literal}")`));
    }
    return true;
  });
  return found;
}

function pythonEntrypoints(input: EntrypointInput): Entrypoint[] {
  const found: Entrypoint[] = [];
  walkNamed(input.tree.root, (node) => {
    if (node.type === "decorated_definition") found.push(...decoratedEntrypoints(input.path, node));
    if (node.type === "call") {
      const parser = subparserCommand(input.path, node);
      if (parser) found.push(parser);
    }
    return true;
  });
  return found;
}

function decoratedEntrypoints(path: string, node: SyntaxNode): Entrypoint[] {
  const definition = field(node, "definition");
  const name = definition ? (field(definition, "name")?.text ?? "") : "";
  const found: Entrypoint[] = [];

  for (const decorator of named(node).filter((child) => child.type === "decorator")) {
    const call = named(decorator).find((child) => child.type === "call");
    const callee = dottedName(call ? field(call, "function") : named(decorator)[0]);
    if (callee === undefined) continue;

    const literal = call ? stringValue(argumentsOf(call)[0]) : undefined;
    const method = lastSegment(callee);

    if (HTTP_METHODS.has(method) && literal?.startsWith("/")) {
      found.push(entrypoint("http_route", path, literal, decorator, `@${callee}("${literal}")`));
    } else if (CLI_COMMAND_NAMES.has(method)) {
      found.push(entrypoint("cli_command", path, literal ?? name, decorator, `@${callee}`));
    }
  }
  return found;
}

function subparserCommand(path: string, node: SyntaxNode): Entrypoint | undefined {
  const callee = dottedName(field(node, "function"));
  if (callee === undefined || lastSegment(callee) !== "add_parser") return undefined;

  const literal = stringValue(argumentsOf(node)[0]);
  if (literal === undefined) return undefined;
  return entrypoint("cli_command", path, literal, node, `${callee}("${literal}")`);
}

/**
 * A test file must show it is one: it imports a test framework, or declares
 * test cases. Living under `tests/` proves nothing on its own.
 */
function testEntrypoint(input: EntrypointInput): Entrypoint | undefined {
  const framework = input.importedModules.find((module) => TEST_FRAMEWORKS.has(module));
  if (framework) {
    return {
      kind: "test_entrypoint",
      path: input.path,
      name: basename(input.path),
      line: 1,
      evidence: `imports ${framework}`,
    };
  }

  const declaration = findTestDeclaration(input.tree);
  if (!declaration) return undefined;
  return {
    kind: "test_entrypoint",
    path: input.path,
    name: basename(input.path),
    line: declaration.line,
    evidence: declaration.evidence,
  };
}

interface TestDeclaration {
  readonly line: number;
  readonly evidence: string;
}

function findTestDeclaration(tree: ParsedTree): TestDeclaration | undefined {
  const python = tree.grammar === "python";
  const callType = python ? "call" : "call_expression";
  let hit: TestDeclaration | undefined;

  walkNamed(tree.root, (node) => {
    if (hit) return false;
    if (python && node.type === "function_definition") hit = pythonTestFunction(node);
    else if (node.type === callType) hit = testCall(node);
    return true;
  });
  return hit;
}

function pythonTestFunction(node: SyntaxNode): TestDeclaration | undefined {
  const name = field(node, "name")?.text ?? "";
  return name.startsWith("test_") ? { line: lineOf(node), evidence: `def ${name}` } : undefined;
}

function testCall(node: SyntaxNode): TestDeclaration | undefined {
  const callee = dottedName(field(node, "function"));
  const root = callee?.split(".")[0] ?? "";
  if (!callee || !TEST_CALLS.has(root)) return undefined;
  return { line: lineOf(node), evidence: `${callee}(...)` };
}

function entrypoint(
  kind: Entrypoint["kind"],
  path: string,
  name: string,
  node: SyntaxNode,
  evidence: string,
): Entrypoint {
  return { kind, path, name, line: lineOf(node), evidence };
}

function lastSegment(dotted: string): string {
  const dot = dotted.lastIndexOf(".");
  return dot === -1 ? dotted : dotted.slice(dot + 1);
}
