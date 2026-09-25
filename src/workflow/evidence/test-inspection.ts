import { posix } from "node:path";
import type { Grammar } from "../../graph/constants.js";
import {
  argumentsOf,
  dottedName,
  field,
  named,
  stringValue,
  walkNamed,
} from "../../graph/extract/nodes.js";
import { parseSource, type SyntaxNode } from "../../graph/extract/parser.js";
import type { Finding } from "../artifacts/evidence.js";
import { type BrowserActions, inspectBrowserActions, testingHelpers } from "./browser-actions.js";
import { inspectBrowserIntegrity } from "./browser-integrity.js";

export interface TestScope {
  readonly browserActions?: BrowserActions;
  readonly name?: string;
  readonly text: string;
  readonly code: string;
  readonly indirect: boolean;
  readonly exclusive?: boolean;
}

export interface TestInspection {
  readonly localTestRegistration?: boolean;
  readonly localModuleSources?: readonly string[];
  readonly browserFindings?: readonly Finding[];
  readonly scopes: readonly TestScope[];
  readonly code: string;
  readonly projectBindings: readonly string[];
  readonly projectImports: readonly { source: string; bindings: readonly string[] }[];
  readonly hasProjectImport: boolean;
  readonly hasDynamicExecutor: boolean;
  readonly uncertainty?: string;
  readonly syntaxError?: { readonly line: number; readonly column: number };
}

const MAX_INSPECTION_CHARS = 1_000_000;
const LITERALS = new Set(["comment", "string", "template_string", "regex"]);
const BRANCHES = new Set(["if_statement", "switch_statement", "ternary_expression"]);
const DEFINITIONS = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "arrow_function",
  "function_expression",
]);
const DIRECT_CALLS = new Set([
  "assert",
  "expect",
  "Number",
  "String",
  "Boolean",
  "parseInt",
  "parseFloat",
]);
const SUITES = /^(?:test\.)?describe(?:\.only)?$/;

/** Bounded syntax inspection only. It never evaluates a test or claims semantic coverage. */
export async function inspectTestSource(path: string, source: string): Promise<TestInspection> {
  const grammar = testGrammar(path);
  if (!grammar || source.length > MAX_INSPECTION_CHARS) {
    return unavailable("The test language or source size is outside bounded inspection");
  }
  const parsed = await parseSource(grammar, source);
  if (parsed.kind !== "parsed")
    return unavailable(`Test syntax could not be inspected (${parsed.kind})`);
  try {
    if (parsed.tree.hasError) {
      return {
        ...unavailable("Test syntax could not be parsed completely"),
        syntaxError: syntaxErrorLocation(parsed.tree.root),
      };
    }
    return inspectTree(parsed.tree.root, path);
  } finally {
    parsed.dispose();
  }
}

function syntaxErrorLocation(root: SyntaxNode): { line: number; column: number } {
  let node = root;
  while (!node.isError && !node.isMissing) {
    const child = node.children.find((value) => value?.hasError || value?.isMissing);
    if (!child) break;
    node = child;
  }
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

function unavailable(uncertainty: string): TestInspection {
  return {
    scopes: [],
    code: "",
    projectBindings: [],
    projectImports: [],
    hasProjectImport: false,
    hasDynamicExecutor: false,
    uncertainty,
  };
}

function testGrammar(path: string): Grammar | undefined {
  if (/\.tsx$/i.test(path)) return "tsx";
  if (/\.[cm]?ts$/i.test(path)) return "typescript";
  return /\.[cm]?jsx?$/i.test(path) ? "javascript" : undefined;
}

function inspectTree(root: SyntaxNode, path: string): TestInspection {
  const browser = inspectBrowserIntegrity(root, path);
  const collected = collectTests(root);
  const imports = localImports(root, path);
  const bindings = new Set(imports.projectBindings);
  const scopes = collected.calls.map((call) => testScope(call, bindings));
  if (!collected.registered) scopes.push(scope(root, bindings));
  return {
    scopes,
    browserFindings: browser.findings,
    localTestRegistration: browser.localRegistration,
    localModuleSources: importedModules(root).filter((source) => source.startsWith(".")),
    code: codeWithout(root, (node) => LITERALS.has(node.type)),
    ...imports,
    ...(collected.uncertainty ? { uncertainty: collected.uncertainty } : {}),
  };
}

function collectTests(root: SyntaxNode): {
  calls: SyntaxNode[];
  registered: boolean;
  uncertainty?: string;
} {
  const tests: SyntaxNode[] = [];
  let registered = false;
  let dynamic = false;
  walkNamed(root, (node) => {
    if (node.type !== "call_expression") return true;
    const callee = dottedName(field(node, "function")) ?? "";
    if (/^(?:(?:test|it)\.(?:skip|todo|fixme)|(?:test\.)?describe\.skip)$/.test(callee)) {
      registered = true;
      return false;
    }
    if (/^(?:test|it)\.(?:each|for)$/.test(callee)) dynamic = registered = true;
    if (!/^(?:test|it)(?:\.only)?$/.test(callee)) return true;
    registered = true;
    if (stringValue(argumentsOf(node)[0]) === undefined || !callbackBody(node)) dynamic = true;
    else tests.push(node);
    return false;
  });
  const uncertainty = dynamic
    ? "Dynamically registered tests cannot be attributed to a named scenario"
    : registered && tests.length === 0
      ? "No inspectable active test case was found"
      : undefined;
  return {
    calls: tests,
    registered,
    uncertainty,
  };
}

function callbackBody(call: SyntaxNode): SyntaxNode | undefined {
  const callback = argumentsOf(call).find((node) =>
    ["arrow_function", "function_expression"].includes(node.type),
  );
  if (callback) return field(callback, "body");

  const namedCallback = argumentsOf(call)[1];
  if (namedCallback?.type !== "identifier") return undefined;
  const declarations: SyntaxNode[] = [];
  let root = call;
  while (root.parent) root = root.parent;
  walkNamed(root, (node) => {
    if (
      node.type === "function_declaration" &&
      field(node, "name")?.text === namedCallback.text &&
      isTopLevelDeclaration(node)
    ) {
      declarations.push(node);
      return false;
    }
    return true;
  });
  const declaration = declarations.length === 1 ? declarations[0] : undefined;
  return declaration ? field(declaration, "body") : undefined;
}

function isTopLevelDeclaration(node: SyntaxNode): boolean {
  let parent = node.parent;
  if (parent?.type === "export_statement") parent = parent.parent;
  return parent?.type === "program";
}

function testScope(call: SyntaxNode, bindings: ReadonlySet<string>): TestScope {
  const body = callbackBody(call);
  const own = scope(body ?? call, bindings);
  const hooks = beforeEachBodies(call).map((body) => scope(body, bindings));
  const identity = caseIdentity(call);
  return {
    ...identity,
    browserActions: own.browserActions,
    text: [identity.name, own.text].join("\n"),
    code: [...hooks.map((hook) => hook.code), own.code].join("\n"),
    indirect: own.indirect || hooks.some((hook) => hook.indirect) || hasConditionalAncestor(call),
  };
}

function caseIdentity(call: SyntaxNode): { name: string; exclusive: boolean } {
  const names = [stringValue(argumentsOf(call)[0]) ?? ""];
  let exclusive = (dottedName(field(call, "function")) ?? "").endsWith(".only");
  for (let parent = call.parent; parent; parent = parent.parent) {
    if (parent.type !== "call_expression") continue;
    const callee = dottedName(field(parent, "function")) ?? "";
    if (!SUITES.test(callee)) continue;
    names.unshift(stringValue(argumentsOf(parent)[0]) ?? "");
    exclusive ||= callee.endsWith(".only");
  }
  return { name: names.join(" ").trim(), exclusive };
}

/** Only hooks in enclosing lexical suites apply; a sibling suite cannot lend its setup. */
function beforeEachBodies(call: SyntaxNode): SyntaxNode[] {
  const bodies: SyntaxNode[] = [];
  for (let parent = call.parent; parent; parent = parent.parent) {
    if (parent.type !== "program" && parent.type !== "statement_block") continue;
    bodies.unshift(...localBeforeEachBodies(parent));
  }
  return bodies;
}

function localBeforeEachBodies(block: SyntaxNode): SyntaxNode[] {
  const bodies: SyntaxNode[] = [];
  for (const statement of named(block)) {
    const call = statement.type === "expression_statement" ? named(statement)[0] : undefined;
    if (!call || dottedName(field(call, "function")) !== "test.beforeEach") continue;
    const body = callbackBody(call);
    if (body) bodies.push(body);
  }
  return bodies;
}

function hasConditionalAncestor(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (BRANCHES.has(parent.type)) return true;
    if (DEFINITIONS.has(parent.type) && !SUITES.test(callbackCallee(parent))) return true;
  }
  return false;
}

function scope(node: SyntaxNode, bindings: ReadonlySet<string>): TestScope {
  let indirect = false;
  const helpers = testingHelpers(node);
  walkNamed(node, (child) => {
    if (LITERALS.has(child.type)) return false;
    if (opaqueExecution(child)) {
      indirect = true;
      return false;
    }
    if (child.type === "call_expression") {
      const callee = field(child, "function");
      if (
        callee?.type === "identifier" &&
        !DIRECT_CALLS.has(callee.text) &&
        !helpers.has(callee.text)
      )
        indirect = true;
      const receiver = dottedName(callee)?.split(".")[0];
      if (receiver && bindings.has(receiver)) indirect = true;
    }
    return true;
  });
  return {
    text: node.text,
    browserActions: inspectBrowserActions(node, helpers),
    code: codeWithout(node, (child) => LITERALS.has(child.type) || opaqueExecution(child)),
    indirect,
  };
}

function callbackCallee(node: SyntaxNode): string {
  const call = node.parent?.type === "arguments" ? node.parent.parent : undefined;
  return call ? (dottedName(field(call, "function")) ?? "") : "";
}

function opaqueExecution(node: SyntaxNode): boolean {
  if (BRANCHES.has(node.type)) return true;
  if (!DEFINITIONS.has(node.type)) return false;
  // Inline DOM reads are part of a known browser operation, not an unused helper.
  return !/\.(?:evaluate|evaluateAll)$/.test(callbackCallee(node));
}

/** Mask non-code without changing offsets, so literals cannot impersonate interactions. */
function codeWithout(root: SyntaxNode, excluded: (node: SyntaxNode) => boolean): string {
  const text = root.text;
  const starts = [0];
  for (const match of text.matchAll(/\n/g)) starts.push(match.index + 1);
  const offset = (position: SyntaxNode["startPosition"]) =>
    (starts[position.row - root.startPosition.row] ?? text.length) +
    position.column -
    (position.row === root.startPosition.row ? root.startPosition.column : 0);
  const chunks: string[] = [];
  let cursor = 0;
  walkNamed(root, (node) => {
    if (!excluded(node)) return true;
    const start = offset(node.startPosition);
    const end = offset(node.endPosition);
    chunks.push(text.slice(cursor, start), text.slice(start, end).replace(/[^\r\n]/g, " "));
    cursor = end;
    return false;
  });
  chunks.push(text.slice(cursor));
  return chunks.join("");
}

function localImports(
  root: SyntaxNode,
  path: string,
): Pick<
  TestInspection,
  "projectBindings" | "projectImports" | "hasProjectImport" | "hasDynamicExecutor"
> {
  const bindings = new Set<string>();
  const projectImports: Array<{ source: string; bindings: string[] }> = [];
  const sources = importedModules(root);
  const hasProjectImport = sources.some((source) => source.startsWith("."));
  for (const statement of named(root)) {
    if (statement.type !== "import_statement") continue;
    const source = stringValue(field(statement, "source"));
    if (!source?.startsWith(".") || isSelfImport(path, source)) continue;
    const local = new Set<string>();
    walkNamed(statement, (node) => {
      if (node.type === "string") return false;
      if (node.type === "import_specifier") {
        const binding = field(node, "alias") ?? field(node, "name");
        if (binding) local.add(binding.text);
        return false;
      }
      if (node.type === "identifier") local.add(node.text);
      return true;
    });
    projectImports.push({ source, bindings: [...local] });
    for (const binding of local) bindings.add(binding);
  }
  return {
    projectBindings: [...bindings],
    projectImports,
    hasProjectImport,
    hasDynamicExecutor:
      sources.some((source) => /^(?:node:)?(?:vm|child_process)$/.test(source)) ||
      invokesConstructedFunction(root) ||
      /\b(?:require\s*\.\s*extensions|\w+\s*\.\s*_compile\s*\()/.test(
        codeWithout(root, (node) => LITERALS.has(node.type)),
      ),
  };
}

function isSelfImport(path: string, source: string): boolean {
  const normalize = (value: string) => posix.normalize(value.replaceAll("\\", "/"));
  return normalize(posix.join(posix.dirname(normalize(path)), source)) === normalize(path);
}

function invokesConstructedFunction(root: SyntaxNode): boolean {
  const constructed = new Set<string>();
  const called = new Set<string>();
  let immediate = false;
  walkNamed(root, (node) => {
    if (node.type === "variable_declarator" && isFunctionConstructor(field(node, "value"))) {
      const name = field(node, "name");
      if (name?.type === "identifier") constructed.add(name.text);
    }
    if (node.type === "call_expression") {
      const callee = field(node, "function");
      if (isFunctionConstructor(callee)) immediate = true;
      const receiver = dottedName(callee)?.split(".")[0];
      if (receiver) called.add(receiver);
    }
    return true;
  });
  return immediate || [...constructed].some((name) => called.has(name));
}

function isFunctionConstructor(node: SyntaxNode | undefined): boolean {
  if (node?.type === "new_expression") return field(node, "constructor")?.text === "Function";
  return node?.type === "call_expression" && field(node, "function")?.text === "Function";
}

function importedModules(root: SyntaxNode): string[] {
  const sources: string[] = [];
  walkNamed(root, (node) => {
    let source: string | undefined;
    if (node.type === "import_statement") source = stringValue(field(node, "source"));
    if (
      node.type === "call_expression" &&
      /^(?:require|import)$/.test(field(node, "function")?.text ?? "")
    ) {
      source = stringValue(argumentsOf(node)[0]);
    }
    if (source !== undefined) sources.push(source);
    return true;
  });
  return sources;
}

export function sourceEvidenceKind(
  inspection: TestInspection,
): "static" | "unassessed" | undefined {
  if (inspection.uncertainty) return "unassessed";
  const { code } = inspection;
  const readsText = /\b(?:readFileSync|readFile)\s*\(/.test(code);
  const examinesText =
    /\.(?:test|includes|match|matchAll|indexOf|search|split|startsWith|endsWith)\s*\(|\bnew\s+Function\s*\(/.test(
      code,
    );
  const asserts = /\b(?:assert(?:\.[A-Za-z]+)?\s*\(|expect\s*\(|throw\s+(?:new\s+)?Error\b)/.test(
    code,
  );
  if (!readsText || !examinesText || !asserts) return undefined;
  const executesDynamically =
    /\b(?:runInNewContext|runInContext|runInThisContext|eval|spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/.test(
      code,
    );
  if (executesDynamically || inspection.hasDynamicExecutor) return "unassessed";
  const calls =
    inspection.scopes
      .map((scope) => scope.code)
      .join("\n")
      .match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/g) ?? [];
  const callsBinding = inspection.projectBindings.some((binding) =>
    calls.some((call) => call.split(/[.\s(]/, 1)[0] === binding),
  );
  if (callsBinding) return undefined;
  // Import evaluation may have side effects; an unused import is not proof of
  // behavior, but neither is it proof that nothing executed.
  return inspection.hasProjectImport ? "unassessed" : "static";
}
