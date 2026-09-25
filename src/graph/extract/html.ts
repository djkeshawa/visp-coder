import { EXTERNAL_PREFIX } from "../constants.js";
import { fileEntityId } from "../ids.js";
import { basename } from "../paths.js";
import type { Entity, Entrypoint, Relation } from "../types.js";
import { htmlScripts } from "./html-scripts.js";
import { type ResolutionContext, resolveScriptImport } from "./resolve.js";

/** Page entry links are scanned without executing page content. */

export interface HtmlExtraction {
  readonly entities: Entity[];
  readonly relations: Relation[];
  readonly entrypoints: Entrypoint[];
}

export function extractHtml(
  path: string,
  source: string,
  context: ResolutionContext,
): HtmlExtraction {
  const relations: Relation[] = [];
  const entrypoints: Entrypoint[] = [];
  const pageEntity = fileEntityId(path);

  const scripts = htmlScripts(source);
  for (const script of scripts) {
    const src = script.attributes.get("src");
    if (!src || isRemote(src)) continue;

    const line = lineAt(source, script.start - script.tag.length);
    const resolved = resolvePageScript(context, path, src);
    if (!resolved) continue;

    relations.push({
      source: pageEntity,
      target: fileEntityId(resolved),
      kind: "imports",
      path,
      line,
    });
    entrypoints.push({
      kind: "page_entrypoint",
      path,
      name: resolved,
      line,
      evidence: script.tag.slice(0, 120),
    });
  }

  const map = scripts.find((script) => script.attributes.get("type") === "importmap");
  if (map) {
    const line = lineAt(source, map.start - map.tag.length);
    for (const name of importMapNames(source.slice(map.start, map.end))) {
      relations.push({
        source: pageEntity,
        target: `${EXTERNAL_PREFIX}${name}`,
        kind: "external",
        path,
        line,
      });
    }
  }

  return {
    entities:
      relations.length > 0
        ? [
            {
              id: pageEntity,
              path,
              kind: "file",
              name: basename(path),
              startLine: 1,
              endLine: source.split("\n").length,
            },
          ]
        : [],
    relations,
    entrypoints,
  };
}

function isRemote(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src);
}

/**
 * Pages write `src="src/main.js"` as often as `./src/main.js`; a bare path in
 * an import specifier would read as a package, so it is retried as relative.
 */
function resolvePageScript(
  context: ResolutionContext,
  path: string,
  src: string,
): string | undefined {
  const candidates = src.startsWith(".") || src.startsWith("/") ? [src] : [`./${src}`, src];
  for (const candidate of candidates) {
    const resolved = resolveScriptImport(context, path, candidate);
    if (resolved.kind === "file") return resolved.path;
  }
  return undefined;
}

function importMapNames(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { imports?: Record<string, unknown> };
    return Object.keys(parsed.imports ?? {}).sort();
  } catch {
    return [];
  }
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}
