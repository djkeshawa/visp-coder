import {
  argumentsOf,
  dottedName,
  field,
  named,
  stringValue,
  walkNamed,
} from "../../graph/extract/nodes.js";
import type { SyntaxNode } from "../../graph/extract/parser.js";
import type { Finding } from "../artifacts/evidence.js";

/** Negative evidence only: these facts cannot establish that a browser ran. */
export function inspectBrowserIntegrity(
  root: SyntaxNode,
  path: string,
): { findings: Finding[]; localRegistration: boolean } {
  const findings: Finding[] = [];
  const receivers = evaluatedReceivers(root);
  let localRegistration = false;
  let registered = false;
  let frameworkRegistration = false;
  walkNamed(root, (node) => {
    if (
      ["function_declaration", "variable_declarator"].includes(node.type) &&
      /^(?:test|it)$/.test(field(node, "name")?.text ?? "")
    )
      localRegistration = true;
    if (
      node.type === "call_expression" &&
      /^(?:test|it)(?:\.|$)/.test(dottedName(field(node, "function")) ?? "")
    )
      registered = true;
    frameworkRegistration ||= isFrameworkImport(node);
    if (node.type === "object" && isUsedConstantBrowser(node, receivers))
      findings.push({
        code: "validation-browser-local-double",
        severity: "error",
        path,
        message: `${path} defines browser navigation alongside an evaluate method returning fixed data`,
        recommendation:
          "Keep doubles as unit or integration evidence. Browser evidence must read outcomes from the running application.",
      });
    if (node.type === "catch_clause" && emitsSuccessReceipt(node))
      findings.push({
        code: "validation-success-on-error",
        severity: "error",
        path,
        message: `${path} emits a successful acceptance receipt inside an error handler`,
        recommendation:
          "Propagate unavailable execution as a failure or skip. Emit success only after the requested check or a verified recovery has completed outside the error handler.",
      });
    return !["string", "template_string", "comment"].includes(node.type);
  });
  if (localRegistration || (registered && !frameworkRegistration))
    findings.push({
      code: "validation-browser-registration-unassessed",
      severity: "warning",
      path,
      message: `${path} has local or unresolved test registration; callback declarations do not establish that any selected case executes`,
      recommendation:
        "Keep the working runner. Inspect its dispatch and executed-case report, or use an existing supported test framework; do not add dormant callbacks to satisfy source inspection.",
    });
  return { findings, localRegistration };
}

function evaluatedReceivers(root: SyntaxNode): Set<string> {
  const receivers = new Set<string>();
  walkNamed(root, (node) => {
    if (node.type === "call_expression") {
      const callee = dottedName(field(node, "function"));
      if (callee?.endsWith(".evaluate"))
        receivers.add(callee.slice(0, -9).replace(/^(?:globalThis|window)\./, ""));
    }
    return true;
  });
  return receivers;
}

function isUsedConstantBrowser(node: SyntaxNode, receivers: ReadonlySet<string>): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const binding = dottedName(
    field(parent, parent.type === "variable_declarator" ? "name" : "left"),
  );
  return (
    binding !== undefined &&
    receivers.has(binding.replace(/^(?:globalThis|window)\./, "")) &&
    isConstantBrowser(node)
  );
}

function isFrameworkImport(node: SyntaxNode): boolean {
  if (node.type !== "import_statement") return false;
  if (
    !/^(?:@playwright\/test|playwright\/test|node:test|vitest|@jest\/globals)$/.test(
      stringValue(field(node, "source")) ?? "",
    )
  )
    return false;
  let supported = false;
  walkNamed(node, (child) => {
    if (child.type === "import_specifier") {
      supported ||=
        /^(?:test|it)$/.test(field(child, "name")?.text ?? "") &&
        /^(?:test|it)$/.test((field(child, "alias") ?? field(child, "name"))?.text ?? "");
    }
    return true;
  });
  return supported;
}

function isConstantBrowser(node: SyntaxNode): boolean {
  const methods = named(node);
  const key = (method: SyntaxNode) => field(method, "name")?.text ?? field(method, "key")?.text;
  if (!methods.some((method) => ["goto", "setContent"].includes(key(method) ?? ""))) return false;
  const evaluate = methods.find((method) => key(method) === "evaluate");
  const value = evaluate && (field(evaluate, "value") ?? evaluate);
  const body = value && field(value, "body");
  if (!body) return false;
  if (literalValue(body)) return true;
  const returns = named(body).filter((child) => child.type === "return_statement");
  const returned = returns[0];
  return returns.length === 1 && returned !== undefined && literalValue(named(returned)[0]);
}

function literalValue(node: SyntaxNode | undefined): boolean {
  if (!node) return false;
  if (["string", "number", "true", "false", "null"].includes(node.type)) return true;
  if (node.type === "object")
    return named(node).every(
      (entry) => entry.type === "pair" && literalValue(field(entry, "value")),
    );
  if (node.type === "array") return named(node).every(literalValue);
  if (node.type === "binary_expression")
    return literalValue(field(node, "left")) && literalValue(field(node, "right"));
  return false;
}

function emitsSuccessReceipt(root: SyntaxNode): boolean {
  let emitted = false;
  walkNamed(root, (node) => {
    if (
      node.type === "call_expression" &&
      /^(?:console\.(?:log|info|error)|process\.(?:stdout|stderr)\.write)$/.test(
        dottedName(field(node, "function")) ?? "",
      )
    ) {
      emitted ||= argumentsOf(node).some((argument) =>
        /(?:^|\n)\s*VISP_ASSERT\s+AC\d{3,}\s+passed\s*(?:$|\n)/i.test(stringValue(argument) ?? ""),
      );
    }
    return true;
  });
  return emitted;
}
