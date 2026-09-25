import { EXTERNAL_PREFIX, isExternalRef } from "./constants.js";
import { pathOfEntityId } from "./ids.js";
import { isTestPath } from "./paths.js";
import type {
  EntityKind,
  FileLanguage,
  GraphSnapshot,
  RelationKind,
  UnknownRecord,
} from "./types.js";

/**
 * The compact view a context pack consumes in process: columnar, evidence-free,
 * and cheap to slice. Nothing here re-reads the store.
 */

export interface GraphProjection {
  readonly nodes: {
    readonly ids: string[];
    readonly paths: string[];
    readonly kinds: EntityKind[];
    readonly names: string[];
    readonly startLines: number[];
    readonly endLines: number[];
  };
  readonly edges: {
    readonly sources: string[];
    readonly targets: string[];
    readonly kinds: RelationKind[];
    readonly paths: string[];
    readonly lines: number[];
  };
  readonly files: {
    readonly paths: string[];
    readonly languages: FileLanguage[];
    /** True when the file produced a file entity, i.e. it was parsed. */
    readonly parsed: boolean[];
  };
  readonly unknowns: UnknownRecord[];
  readonly counts: {
    readonly nodes: number;
    readonly edges: number;
    readonly unknowns: number;
    readonly files: number;
    readonly entrypoints: number;
  };
}

export function projectGraph(snapshot: GraphSnapshot): GraphProjection {
  const parsedPaths = new Set(
    snapshot.entities.filter((entity) => entity.kind === "file").map((entity) => entity.path),
  );

  return {
    nodes: {
      ids: snapshot.entities.map((entity) => entity.id),
      paths: snapshot.entities.map((entity) => entity.path),
      kinds: snapshot.entities.map((entity) => entity.kind),
      names: snapshot.entities.map((entity) => entity.name),
      startLines: snapshot.entities.map((entity) => entity.startLine),
      endLines: snapshot.entities.map((entity) => entity.endLine),
    },
    edges: {
      sources: snapshot.relations.map((relation) => relation.source),
      targets: snapshot.relations.map((relation) => relation.target),
      kinds: snapshot.relations.map((relation) => relation.kind),
      paths: snapshot.relations.map((relation) => relation.path),
      lines: snapshot.relations.map((relation) => relation.line),
    },
    files: {
      paths: snapshot.files.map((file) => file.path),
      languages: snapshot.files.map((file) => file.language),
      parsed: snapshot.files.map((file) => parsedPaths.has(file.path)),
    },
    unknowns: snapshot.unknowns,
    counts: {
      nodes: snapshot.entities.length,
      edges: snapshot.relations.length,
      unknowns: snapshot.unknowns.length,
      files: snapshot.files.length,
      entrypoints: snapshot.entrypoints.length,
    },
  };
}

export interface FileEdge {
  readonly from: string;
  readonly to: string;
}

export interface ExternalDependency {
  readonly from: string;
  readonly module: string;
}

export interface FileGraph {
  readonly files: string[];
  readonly testFiles: string[];
  readonly dependencyEdges: FileEdge[];
  readonly testEdges: FileEdge[];
  readonly externalDeps: ExternalDependency[];
  readonly unparsedFiles: string[];
}

export function collapseToFileGraph(projection: GraphProjection): FileGraph {
  const edges = collectFileEdges(projection);
  propagateReexportedTests(edges.test, edges.reexport);

  const files = [...projection.files.paths].sort();
  return {
    files,
    testFiles: files.filter(isTestPath),
    dependencyEdges: sortEdges(edges.dependency.values()),
    testEdges: sortEdges(edges.test.values()),
    externalDeps: [...edges.external.values()].sort(
      (a, b) => compare(a.from, b.from) || compare(a.module, b.module),
    ),
    unparsedFiles: projection.files.paths
      .filter((_, index) => projection.files.parsed[index] !== true)
      .sort(),
  };
}

interface FileEdgeCollections {
  readonly dependency: Map<string, FileEdge>;
  readonly test: Map<string, FileEdge>;
  readonly reexport: Map<string, FileEdge>;
  readonly external: Map<string, ExternalDependency>;
}

function collectFileEdges(projection: GraphProjection): FileEdgeCollections {
  const edges: FileEdgeCollections = {
    dependency: new Map(),
    test: new Map(),
    reexport: new Map(),
    external: new Map(),
  };

  for (let index = 0; index < projection.edges.kinds.length; index += 1) {
    collectFileEdge(projection, index, edges);
  }
  return edges;
}

function collectFileEdge(
  projection: GraphProjection,
  index: number,
  edges: FileEdgeCollections,
): void {
  const kind = projection.edges.kinds[index];
  const from = pathOfEntityId(projection.edges.sources[index] ?? "");
  const rawTarget = projection.edges.targets[index] ?? "";

  if (kind === "external") {
    const module = rawTarget.slice(EXTERNAL_PREFIX.length);
    edges.external.set(`${from} ${module}`, { from, module });
    return;
  }
  if (isExternalRef(rawTarget)) return;

  const to = pathOfEntityId(rawTarget);
  if (from === to) return;
  recordFileEdge(edges, kind, { from, to });
}

function recordFileEdge(
  edges: FileEdgeCollections,
  kind: RelationKind | undefined,
  edge: FileEdge,
): void {
  const key = `${edge.from} ${edge.to}`;
  if (kind === "imports") edges.dependency.set(key, edge);
  else if (kind === "tested_by") edges.test.set(key, edge);
  // `export { x } from "./y"` in a barrel: the cross-file exports edge is
  // the barrel saying "what I offer actually lives there".
  else if (kind === "exports") edges.reexport.set(key, edge);
}

function propagateReexportedTests(
  testEdges: Map<string, FileEdge>,
  reexportEdges: ReadonlyMap<string, FileEdge>,
): void {
  // A test importing a barrel covers what the barrel re-exports. Crediting
  // only the barrel left the real modules reading as untested, one hop away.
  for (const test of [...testEdges.values()]) {
    for (const reexport of reexportEdges.values()) {
      if (reexport.from !== test.from) continue;
      testEdges.set(`${reexport.to} ${test.to}`, { from: reexport.to, to: test.to });
    }
  }
}

/**
 * The changed files and every importer reachable by repeatedly following
 * dependency edges backwards. Re-export sources are imports edges too, so a
 * barrel remains part of the same closure. The visited set makes cycles
 * finite; sorting both the walk and result keeps refreshes reproducible.
 */
export function reverseImportClosure(
  projection: GraphProjection,
  seeds: Iterable<string>,
): string[] {
  const reverseImporters = new Map<string, string[]>();
  for (const edge of collapseToFileGraph(projection).dependencyEdges) {
    const importers = reverseImporters.get(edge.to);
    if (importers) importers.push(edge.from);
    else reverseImporters.set(edge.to, [edge.from]);
  }

  const closure = new Set(seeds);
  let frontier = [...closure].sort(compare);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const importer of reverseImporters.get(path) ?? []) {
        if (closure.has(importer)) continue;
        closure.add(importer);
        next.push(importer);
      }
    }
    frontier = next.sort(compare);
  }

  return [...closure].sort(compare);
}

/**
 * Which test files the graph says cover each of these paths. Test edges run
 * `{from: module, to: test}` — this is the one place that direction is read, so
 * every consumer asking "what tests this file" agrees on it.
 */
export function coverageFor(
  fileGraph: FileGraph,
  paths: readonly string[],
): Record<string, string[]> {
  const wanted = new Set(paths);
  const coverage: Record<string, string[]> = {};

  for (const path of paths) coverage[path] = [];

  for (const edge of fileGraph.testEdges) {
    if (!wanted.has(edge.from)) continue;
    coverage[edge.from]?.push(edge.to);
  }

  for (const tests of Object.values(coverage)) tests.sort();
  return coverage;
}

export interface NeighbourhoodFile {
  readonly path: string;
  readonly hops: number;
}

export interface Neighbourhood {
  readonly files: NeighbourhoodFile[];
  /** Seeds that are not in the graph at all. */
  readonly absentSeeds: string[];
  /** Seeds that are in the graph but have no structural neighbours. */
  readonly isolatedSeeds: string[];
  readonly truncated: boolean;
}

/**
 * Files structurally near the seeds, in whole hops over import and test edges.
 * A seed the graph has never seen and a seed with no neighbours are different
 * facts, so they are reported separately.
 */
export function structuralNeighbourhood(
  projection: GraphProjection,
  seeds: readonly string[],
  hops: number,
  maxFiles: number,
): Neighbourhood {
  const fileGraph = collapseToFileGraph(projection);
  const known = new Set(fileGraph.files);
  const adjacency = buildAdjacency([...fileGraph.dependencyEdges, ...fileGraph.testEdges]);

  const absentSeeds = seeds.filter((seed) => !known.has(seed)).sort();
  const presentSeeds = seeds.filter((seed) => known.has(seed)).sort();
  const isolatedSeeds = presentSeeds
    .filter((seed) => (adjacency.get(seed)?.size ?? 0) === 0)
    .sort();

  const distances = walkDistances(adjacency, presentSeeds, hops);

  const ordered = [...distances.entries()]
    .map(([path, distance]) => ({ path, hops: distance }))
    .sort((a, b) => a.hops - b.hops || compare(a.path, b.path));

  return {
    files: ordered.slice(0, Math.max(0, maxFiles)),
    absentSeeds,
    isolatedSeeds,
    truncated: ordered.length > Math.max(0, maxFiles),
  };
}

/**
 * Hop distance from the seeds for every file within the horizon. The same walk
 * `structuralNeighbourhood` reports, exposed for callers that need to order an
 * unrelated list — entrypoints, say — by how near the task's code it sits.
 */
export function structuralDistances(
  projection: GraphProjection,
  seeds: readonly string[],
  hops: number,
): Map<string, number> {
  const fileGraph = collapseToFileGraph(projection);
  const known = new Set(fileGraph.files);
  const adjacency = buildAdjacency([...fileGraph.dependencyEdges, ...fileGraph.testEdges]);

  return walkDistances(adjacency, seeds.filter((seed) => known.has(seed)).sort(), hops);
}

function walkDistances(
  adjacency: Map<string, Set<string>>,
  seeds: readonly string[],
  hops: number,
): Map<string, number> {
  const distances = new Map<string, number>();
  for (const seed of seeds) distances.set(seed, 0);
  let frontier = [...seeds];

  for (let hop = 1; hop <= Math.max(0, hops) && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const neighbour of adjacency.get(path) ?? []) {
        if (distances.has(neighbour)) continue;
        distances.set(neighbour, hop);
        next.push(neighbour);
      }
    }
    frontier = next.sort();
  }

  return distances;
}

export interface EntityRegion {
  readonly startLine: number;
  readonly endLine: number;
  readonly label: string;
}

/**
 * The line ranges worth reading in each of these files, named by what lives
 * there. Two tiers: entities the seed files actually reach into a file for —
 * call and import targets — come first, then the file's exported surface. The
 * regex head-of-file guess this replaces could not tell either apart from a
 * private helper.
 */
export function entityRegions(
  projection: GraphProjection,
  seeds: readonly string[],
  paths: readonly string[],
  maxPerFile: number,
): Record<string, EntityRegion[]> {
  const nodeIndex = new Map(projection.nodes.ids.map((id, index) => [id, index]));
  const candidates = collectRegionCandidates(projection, new Set(seeds), new Set(paths));
  return describeRegionsByPath(projection, nodeIndex, candidates, paths, maxPerFile);
}

interface RegionCandidates {
  readonly reached: Map<string, Set<string>>;
  readonly exported: Map<string, Set<string>>;
}

function collectRegionCandidates(
  projection: GraphProjection,
  seeds: ReadonlySet<string>,
  wanted: ReadonlySet<string>,
): RegionCandidates {
  const candidates: RegionCandidates = { reached: new Map(), exported: new Map() };
  for (let index = 0; index < projection.edges.kinds.length; index += 1) {
    collectRegionCandidate(projection, index, seeds, wanted, candidates);
  }
  return candidates;
}

function collectRegionCandidate(
  projection: GraphProjection,
  index: number,
  seeds: ReadonlySet<string>,
  wanted: ReadonlySet<string>,
  candidates: RegionCandidates,
): void {
  const target = projection.edges.targets[index] ?? "";
  if (isExternalRef(target)) return;

  const targetPath = pathOfEntityId(target);
  if (!wanted.has(targetPath)) return;

  const kind = projection.edges.kinds[index];
  const sourcePath = pathOfEntityId(projection.edges.sources[index] ?? "");
  if ((kind === "calls" || kind === "imports") && seeds.has(sourcePath)) {
    if (sourcePath !== targetPath) recordRegionCandidate(candidates.reached, targetPath, target);
    return;
  }
  if (kind === "exports" && sourcePath === targetPath) {
    recordRegionCandidate(candidates.exported, targetPath, target);
  }
}

function recordRegionCandidate(into: Map<string, Set<string>>, path: string, id: string): void {
  const existing = into.get(path);
  if (existing) existing.add(id);
  else into.set(path, new Set([id]));
}

function describeRegionsByPath(
  projection: GraphProjection,
  nodeIndex: Map<string, number>,
  candidates: RegionCandidates,
  paths: readonly string[],
  maxPerFile: number,
): Record<string, EntityRegion[]> {
  const regions: Record<string, EntityRegion[]> = {};
  for (const path of paths) {
    const primary = candidates.reached.get(path) ?? new Set<string>();
    const rest = [...(candidates.exported.get(path) ?? [])].filter((id) => !primary.has(id));
    const limit = Math.max(0, maxPerFile);
    const reached = describeEntities(projection, nodeIndex, [...primary], "");
    const selectedReached = representativeRegions(reached, limit);
    const remaining = Math.max(0, limit - selectedReached.length);
    regions[path] = [
      ...selectedReached,
      ...representativeRegions(
        describeEntities(projection, nodeIndex, rest, "exported "),
        remaining,
      ),
    ];
  }

  return regions;
}

/** Preserve relevance tiers while representing the beginning, middle, and end of a large file. */
function representativeRegions(regions: readonly EntityRegion[], limit: number): EntityRegion[] {
  if (limit <= 0) return [];
  if (regions.length <= limit) return [...regions];
  if (limit === 1) return regions[0] ? [regions[0]] : [];

  const selected = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    selected.add(Math.round((index * (regions.length - 1)) / (limit - 1)));
  }
  return [...selected].map((index) => regions[index]).filter((region) => region !== undefined);
}

function describeEntities(
  projection: GraphProjection,
  nodeIndex: Map<string, number>,
  ids: readonly string[],
  prefix: string,
): EntityRegion[] {
  const described: EntityRegion[] = [];

  for (const id of ids) {
    const index = nodeIndex.get(id);
    if (index === undefined) continue;

    const kind = projection.nodes.kinds[index];
    // A file-kind entity spans the whole file, which is not a region to read.
    if (kind === "file") continue;

    described.push({
      startLine: projection.nodes.startLines[index] ?? 1,
      endLine: projection.nodes.endLines[index] ?? 1,
      label: `${prefix}${kind} ${projection.nodes.names[index]}`,
    });
  }

  return described.sort((a, b) => a.startLine - b.startLine || compare(a.label, b.label));
}

function buildAdjacency(edges: readonly FileEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    link(adjacency, edge.from, edge.to);
    link(adjacency, edge.to, edge.from);
  }
  return adjacency;
}

function link(adjacency: Map<string, Set<string>>, from: string, to: string): void {
  const existing = adjacency.get(from);
  if (existing) existing.add(to);
  else adjacency.set(from, new Set([to]));
}

function sortEdges(edges: Iterable<FileEdge>): FileEdge[] {
  return [...edges].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
