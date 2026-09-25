import type { Language } from "../../core/constants.js";
import { ok, type Result } from "../../core/result.js";
import { GRAMMAR_BY_EXTENSION, UNPARSED_SOURCE_EXTENSIONS } from "../constants.js";
import { extensionOf, grammarForPath, isHtmlPath, isPackageManifest } from "../paths.js";
import type {
  Entity,
  Entrypoint,
  ExtractionFacts,
  FileEntry,
  FileLanguage,
  LanguageCoverage,
  Relation,
  SkippedFile,
} from "../types.js";
import { type CallSite, collectCallSites, resolveCalls } from "./calls.js";
import { extractEntities } from "./entities.js";
import { extractEntrypoints } from "./entrypoints.js";
import { extractHtml } from "./html.js";
import { inlineJavaScript } from "./html-scripts.js";
import { extractImports } from "./imports.js";
import { extractManifest } from "./manifest.js";
import { type ParsedTree, parseSource } from "./parser.js";
import { createResolutionContext, type ResolutionContext } from "./resolve.js";
import { extractTestRelations } from "./tests.js";
import { type AliasTable, loadAliases } from "./tsconfig.js";
import { UnknownCollector } from "./unknowns.js";

/**
 * The extraction pipeline. Each concern lives in its own module; this file only
 * sequences them and merges what they report.
 */

export interface ExtractionRequest {
  readonly root: string;
  /** Every walked file, so imports resolve against the whole worktree. */
  readonly files: readonly FileEntry[];
  /** The subset to parse. A full index passes all of `files`. */
  readonly parseFiles: readonly FileEntry[];
  readonly skipped: readonly SkippedFile[];
  readonly languages: readonly Language[];
  /** Entities already known from a prior snapshot, so partial runs still resolve. */
  readonly knownEntities?: readonly Entity[];
  /** Reuse the exact config resolution whose identity was checked by refresh. */
  readonly aliases?: AliasTable;
  readonly readSource: (path: string) => Promise<Result<string>>;
}

export interface ExtractionOutcome extends ExtractionFacts {
  readonly parsedPaths: string[];
}

interface FileFacts {
  readonly path: string;
  readonly sites: CallSite[];
  readonly bindings: Map<string, string>;
  readonly reexports: Map<string, string>;
  readonly entities: Entity[];
}

export async function extractRepository(
  request: ExtractionRequest,
): Promise<Result<ExtractionOutcome>> {
  const run = new ExtractionRun(request);
  await run.prepare();
  for (const file of request.parseFiles) await run.handle(file);
  return ok(run.finish());
}

class ExtractionRun {
  private readonly unknowns = new UnknownCollector();
  private readonly entities: Entity[] = [];
  private readonly relations: Relation[] = [];
  private readonly entrypoints: Entrypoint[] = [];
  private readonly facts: FileFacts[] = [];
  private readonly parsedPaths = new Set<string>();
  private readonly unsupported = new Map<string, string>();
  private readonly enabled: Set<string>;
  private context: ResolutionContext;

  constructor(private readonly request: ExtractionRequest) {
    this.enabled = new Set<string>(request.languages);
    this.context = createResolutionContext(
      request.files.map((file) => file.path),
      { aliases: [], problems: [] },
    );
  }

  async prepare(): Promise<void> {
    const aliases = this.request.aliases ?? (await loadAliases(this.request.root));
    for (const problem of aliases.problems) {
      this.unknowns.record("parser_error", problem, "tsconfig could not be read");
    }
    this.context = createResolutionContext(
      this.request.files.map((file) => file.path),
      aliases,
    );
    for (const skip of this.request.skipped) {
      this.unknowns.record("file_skipped", skip.path, skip.reason);
    }
  }

  async handle(file: FileEntry): Promise<void> {
    const source = await this.request.readSource(file.path);
    if (!source.ok) {
      this.unknowns.record("file_skipped", file.path, source.error.message);
      return;
    }

    if (isPackageManifest(file.path)) {
      const manifest = extractManifest(file.path, source.value);
      this.entrypoints.push(...manifest.entrypoints);
      this.unknowns.addAll(manifest.unknowns);
      return;
    }

    // A page's script tags are a browser app's real entry chain; without them
    // the application hub is a graph island no neighbourhood walk can reach.
    if (isHtmlPath(file.path)) {
      await this.parseHtml(file, source.value);
      return;
    }

    const grammar = grammarForPath(file.path);
    if (grammar === undefined || !this.enabled.has(file.language)) {
      this.noteUnsupported(file);
      return;
    }
    await this.parse(file, grammar, source.value);
  }

  private async parseHtml(file: FileEntry, source: string): Promise<void> {
    const page = extractHtml(file.path, source, this.context);
    this.entities.push(...page.entities);
    this.relations.push(...page.relations);
    this.entrypoints.push(...page.entrypoints);
    if (page.relations.length > 0) this.parsedPaths.add(file.path);
    if (this.enabled.has("javascript")) {
      const inline = inlineJavaScript(source);
      if (inline.scripts.length) {
        await this.parse(file, "javascript", inline.source);
        if (inline.scripts.length > 1) {
          // Independent module scopes must not be merged into invented call edges.
          const index = this.facts.findIndex((facts) => facts.path === file.path);
          if (index >= 0) this.facts.splice(index, 1);
          this.unknowns.record(
            "parser_error",
            file.path,
            "Multiple inline script scopes: declarations/imports indexed; call resolution withheld",
          );
        }
      }
    }
  }

  private async parse(
    file: FileEntry,
    grammar: NonNullable<ReturnType<typeof grammarForPath>>,
    source: string,
  ): Promise<void> {
    const outcome = await parseSource(grammar, source);
    if (outcome.kind === "timeout") {
      this.unknowns.record("parse_timeout", file.path, `exceeded parse budget`);
      return;
    }
    if (outcome.kind === "failed") {
      this.unknowns.record("parser_error", file.path, outcome.detail);
      return;
    }

    try {
      this.extractFrom(file, outcome.tree);
    } finally {
      outcome.dispose();
    }
  }

  private extractFrom(file: FileEntry, tree: ParsedTree): void {
    if (tree.hasError) this.unknowns.record("parser_error", file.path, "syntax error in source");

    const entities = extractEntities(file.path, tree);
    const imports = extractImports(file.path, tree, this.context, entities.byName);
    const entrypoints = extractEntrypoints({
      path: file.path,
      tree,
      importedModules: imports.importedModules,
    });

    this.entities.push(...entities.entities);
    this.relations.push(...entities.relations, ...imports.relations);
    this.relations.push(...extractTestRelations(file.path, imports.relations));
    this.entrypoints.push(...entrypoints);
    this.unknowns.addAll(imports.unknowns);
    this.parsedPaths.add(file.path);
    this.facts.push({
      path: file.path,
      sites: collectCallSites(file.path, tree),
      bindings: imports.bindings,
      reexports: imports.reexports,
      entities: entities.entities,
    });
  }

  private noteUnsupported(file: FileEntry): void {
    const extension = extensionOf(file.path);

    // Source code the extractor cannot read is worth reporting: a Go file, or a
    // language the project switched off in visp.yml. A README or a .gitignore is
    // not — it was never going to be parsed, and saying so would drown the
    // unknowns a reader should act on.
    const isSource = extension in GRAMMAR_BY_EXTENSION || UNPARSED_SOURCE_EXTENSIONS.has(extension);
    if (!isSource) return;

    const existing = this.unsupported.get(extension);
    if (existing === undefined || file.path < existing) this.unsupported.set(extension, file.path);
  }

  finish(): ExtractionOutcome {
    this.resolveCallSites();
    for (const [extension, path] of this.unsupported) {
      this.unknowns.record("unsupported_language", path, extension);
    }

    return {
      entities: [...new Map(this.entities.map((entity) => [entity.id, entity])).values()].sort(
        byEntity,
      ),
      relations: dedupeRelations(this.relations),
      unknowns: this.unknowns.toArray(),
      entrypoints: [...this.entrypoints].sort(byEntrypoint),
      languageCoverage: computeLanguageCoverage(this.request.files, this.parsedPaths),
      parsedPaths: [...this.parsedPaths].sort(),
    };
  }

  private resolveCallSites(): void {
    const byFile = new Map<string, Map<string, Entity>>();
    for (const entity of [...(this.request.knownEntities ?? []), ...this.entities]) {
      if (entity.kind === "file") continue;
      const names = byFile.get(entity.path) ?? new Map<string, Entity>();
      if (!names.has(entity.name)) names.set(entity.name, entity);
      byFile.set(entity.path, names);
    }

    // Only the files parsed this run contribute re-export maps: an unchanged
    // barrel's chain is invisible to a partial refresh, which is one more
    // reason refresh re-parses the importers of what changed.
    const reexports = new Map<string, ReadonlyMap<string, string>>();
    for (const file of this.facts) {
      if (file.reexports.size > 0) reexports.set(file.path, file.reexports);
    }

    for (const file of this.facts) {
      const local = byFile.get(file.path) ?? new Map<string, Entity>();
      const resolved = resolveCalls(file.sites, {
        path: file.path,
        local,
        bindings: file.bindings,
        byFile,
        reexports,
        enclosing: file.entities,
      });
      this.relations.push(...resolved.relations);
      this.unknowns.addAll(resolved.unknowns);
    }
  }
}

export function computeLanguageCoverage(
  files: readonly FileEntry[],
  parsedPaths: ReadonlySet<string>,
): LanguageCoverage[] {
  const totals = new Map<FileLanguage, { total: number; parsed: number }>();
  for (const file of files) {
    const entry = totals.get(file.language) ?? { total: 0, parsed: 0 };
    entry.total += 1;
    if (parsedPaths.has(file.path)) entry.parsed += 1;
    totals.set(file.language, entry);
  }

  return [...totals.entries()]
    .map(([language, counts]) => ({
      language,
      totalFiles: counts.total,
      parsedFiles: counts.parsed,
    }))
    .sort((a, b) => (a.language < b.language ? -1 : 1));
}

export function dedupeRelations(relations: readonly Relation[]): Relation[] {
  const seen = new Map<string, Relation>();
  for (const relation of relations) {
    seen.set(
      `${relation.source}\u0000${relation.target}\u0000${relation.kind}\u0000${relation.path}\u0000${relation.line}`,
      relation,
    );
  }
  return [...seen.values()].sort(byRelation);
}

export function byRelation(a: Relation, b: Relation): number {
  return (
    compare(a.path, b.path) ||
    a.line - b.line ||
    compare(a.kind, b.kind) ||
    compare(a.source, b.source) ||
    compare(a.target, b.target)
  );
}

function byEntity(a: Entity, b: Entity): number {
  return compare(a.path, b.path) || a.startLine - b.startLine || compare(a.id, b.id);
}

function byEntrypoint(a: Entrypoint, b: Entrypoint): number {
  return (
    compare(a.path, b.path) || a.line - b.line || compare(a.kind, b.kind) || compare(a.name, b.name)
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { parseCount, resetParseCount } from "./parser.js";
