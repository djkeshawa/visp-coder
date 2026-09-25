import { EntityIdAllocator, fileEntityId } from "../ids.js";
import { basename } from "../paths.js";
import type { Entity, EntityKind, Relation } from "../types.js";
import { endLineOf, field, lineOf, named } from "./nodes.js";
import type { ParsedTree, SyntaxNode } from "./parser.js";

export interface EntityExtraction {
  readonly entities: Entity[];
  readonly relations: Relation[];
  /** Top-level entities by name, used by call resolution within the file's scope. */
  readonly byName: Map<string, Entity>;
}

const SCRIPT_KINDS: Readonly<Record<string, EntityKind>> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  function_signature: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  method_definition: "method",
  method_signature: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "type",
  internal_module: "module",
  module: "module",
};

const PYTHON_KINDS: Readonly<Record<string, EntityKind>> = {
  function_definition: "function",
  class_definition: "class",
};

/** Function-valued declarations read as functions, not as variables that happen to hold one. */
const FUNCTION_VALUE_TYPES = new Set(["arrow_function", "function_expression", "function"]);

export function extractEntities(path: string, tree: ParsedTree): EntityExtraction {
  const allocator = new EntityIdAllocator();
  const fileEntity: Entity = {
    id: fileEntityId(path),
    path,
    kind: "file",
    name: basename(path),
    startLine: 1,
    endLine: endLineOf(tree.root),
  };

  const context: Context = {
    path,
    python: tree.grammar === "python",
    allocator,
    fileEntity,
    entities: [fileEntity],
    relations: [],
  };

  for (const child of named(tree.root)) visit(context, child, fileEntity);

  const byName = new Map<string, Entity>();
  for (const entity of context.entities) {
    if (entity.kind !== "file" && !byName.has(entity.name)) byName.set(entity.name, entity);
  }
  return { entities: context.entities, relations: context.relations, byName };
}

interface Context {
  readonly path: string;
  readonly python: boolean;
  readonly allocator: EntityIdAllocator;
  readonly fileEntity: Entity;
  readonly entities: Entity[];
  readonly relations: Relation[];
}

function visit(context: Context, node: SyntaxNode, parent: Entity): void {
  const created = declare(context, node, parent);
  const next = created ?? parent;
  for (const child of named(node)) visit(context, child, next);
}

function declare(context: Context, node: SyntaxNode, parent: Entity): Entity | undefined {
  const kind = kindOf(context, node, parent);
  if (!kind) return undefined;

  const name = nameOf(node);
  if (!name) return undefined;

  const entity: Entity = {
    id: context.allocator.allocate(context.path, kind, name),
    path: context.path,
    kind,
    name,
    startLine: lineOf(node),
    endLine: endLineOf(node),
  };
  context.entities.push(entity);
  context.relations.push(
    relation(context.fileEntity.id, entity.id, "defines", context.path, entity.startLine),
  );
  if (parent.kind !== "file") {
    context.relations.push(
      relation(parent.id, entity.id, "contains", context.path, entity.startLine),
    );
  }
  return entity;
}

function kindOf(context: Context, node: SyntaxNode, parent: Entity): EntityKind | undefined {
  if (context.python) return pythonKind(node, parent);
  if (node.type === "variable_declarator") return declaratorKind(node, parent);
  return SCRIPT_KINDS[node.type];
}

function pythonKind(node: SyntaxNode, parent: Entity): EntityKind | undefined {
  if (node.type === "function_definition") return parent.kind === "class" ? "method" : "function";
  if (node.type === "assignment") {
    return parent.kind === "file" && field(node, "left")?.type === "identifier"
      ? "variable"
      : undefined;
  }
  return PYTHON_KINDS[node.type];
}

/** Only module-level declarations become entities; locals belong to their function. */
function declaratorKind(node: SyntaxNode, parent: Entity): EntityKind | undefined {
  if (parent.kind !== "file") return undefined;
  const value = field(node, "value");
  return value && FUNCTION_VALUE_TYPES.has(value.type) ? "function" : "variable";
}

function nameOf(node: SyntaxNode): string | undefined {
  const name = field(node, "name") ?? field(node, "left");
  if (!name) return undefined;
  const text = name.text.trim();
  return text === "" || text.includes("\n") ? undefined : text;
}

function relation(
  source: string,
  target: string,
  kind: Relation["kind"],
  path: string,
  line: number,
): Relation {
  return { source, target, kind, path, line };
}
