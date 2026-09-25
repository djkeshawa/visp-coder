import { join } from "node:path";
import { vispError } from "../core/errors.js";
import type { ProjectFileSystem } from "../core/fs.js";
import { sha256 } from "../core/hash.js";
import { err, ok, type Result } from "../core/result.js";
import type { WorkspaceState } from "../workflow/state.js";
import { authorityClaim, type Origin, type Provenance, screenNote } from "./quarantine.js";

/**
 * Durable project notes, kept as plain markdown so a human can read and edit
 * them. Recalled notes are data, never instructions: see {@link screenNote}.
 */

export interface MemoryNote {
  readonly id: string;
  /** Empty when the note was withheld; `quarantined` then says why. */
  readonly text: string;
  readonly createdAt: string;
  /** Where the note came from, as recorded when it was written. */
  readonly provenance: Provenance;
  /** Set when the note was withheld, naming the reason it was not released. */
  readonly quarantined?: string;
}

/** A released note shaped for bounded delivery into a product context. */
export interface RelevantMemoryNote {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly provenance: Provenance;
  readonly source: string;
  readonly label: "advice" | "unverified-fact";
  /** Memory has no validation receipt; callers must not treat it as evidence. */
  readonly verification: "unverified";
  /** Unversioned notes do not carry enough information to infer staleness. */
  readonly freshness: "unknown";
  readonly truncated?: boolean;
}

export interface RelevantMemoryOptions {
  /** Terms from the current task, brief, outcomes and checks. */
  readonly terms?: readonly string[];
  /** Current source paths; path components participate in relevance ranking. */
  readonly paths?: readonly string[];
  readonly maxNotes?: number;
  readonly maxBytes?: number;
}

/**
 * Records a note, stamping how it got in.
 *
 * The marker is written now rather than worked out at recall, because by recall
 * there is nothing left to work it out from: a file in `.visp/memory/` looks
 * identical whether the recording command wrote it or something else dropped it
 * there. This is the one moment that knows.
 *
 * Be exact about what that buys. The marker is a line in a tracked file, so
 * anyone able to write into the repository can type it, and a coding agent is
 * able to — `decideScope` in {@link ../orchestrate/guard.ts} allows every write
 * under `.visp/` before it consults scope at all, and an agent can equally just
 * run `visp learn` itself. So `local` does not mean "a human wrote this". It
 * means the note was admitted through this project's own recording command, or
 * by an edit to a tracked file that will show up in a diff — which is a claim
 * someone can be held to, and is all provenance was ever able to offer. What
 * holds against a writer who forges the marker is the authority check, and it is
 * applied to local notes for exactly that reason.
 *
 * A note that claims authority is refused here rather than stored and withheld
 * forever, so the person who wrote it finds out while they can still rephrase.
 */
export async function learn(state: WorkspaceState, text: string): Promise<Result<MemoryNote>> {
  const claim = authorityClaim(text);
  if (claim) {
    return err(
      vispError("UNSUPPORTED", `This note ${claim}, which is not something a note decides`, {
        recovery: "Record it as an observation instead, or set it where it belongs in visp.yml",
      }),
    );
  }

  const id = sha256(text).slice(0, 12);
  const createdAt = new Date().toISOString();
  const note: MemoryNote = { id, text, createdAt, provenance: "local" };

  const written = await state.files.writeTextAtomic(
    join(state.paths.memoryDir, `${id}.md`),
    `<!-- recorded ${createdAt} provenance=local -->\n${text}\n`,
  );
  if (!written.ok) return written;
  return ok(note);
}

/**
 * Returns notes matching a query.
 *
 * A note visp cannot trace to an admission here, and any note claiming authority
 * whatever its provenance, comes back with its text empty and the reason in
 * `quarantined`. It is still listed: a caller told nothing about a withheld note
 * learns nothing about why its notes are missing, and the id is what a person
 * needs to go read the file themselves.
 *
 * The query is matched only against notes that will be released. Filtering on
 * text that is then withheld would answer questions about that text one
 * substring at a time, which is the leak the withholding exists to prevent — so
 * a withheld note is listed whether or not the query would have matched it.
 */
export async function recall(state: WorkspaceState, query?: string): Promise<Result<MemoryNote[]>> {
  const entries = await state.files.listDir(state.paths.memoryDir);
  if (!entries.ok) return entries;

  const notes: MemoryNote[] = [];
  const needle = query?.toLowerCase();

  for (const entry of entries.value) {
    if (!entry.endsWith(".md")) continue;

    const note = await readNote(state.files, state.paths.memoryDir, entry, needle);
    if (!note.ok) return note;
    if (note.value) notes.push(note.value);
  }

  return ok(notes);
}

/**
 * Selects a small, relevant memory slice for context delivery.
 *
 * This scans the existing note directory through the same quarantine boundary as
 * `recall`, but returns only released notes that overlap the current task or its
 * paths. Ranking is deterministic and lexical: no model call, admission and
 * filesystem mutation are involved. `freshness: "unknown"` is deliberate because
 * an unversioned note cannot establish whether it still describes the worktree.
 */
export async function recallRelevant(
  state: WorkspaceState,
  options: RelevantMemoryOptions = {},
): Promise<Result<RelevantMemoryNote[]>> {
  if (!state.config.memory.enabled) return ok([]);

  const terms = uniqueTokens([...(options.terms ?? []), ...(options.paths ?? [])]);
  if (!terms.length) return ok([]);

  const recalled = await recall(state);
  if (!recalled.ok) return recalled;

  const ranked = recalled.value
    .filter((note) => note.quarantined === undefined && note.text.length > 0)
    .map((note) => ({ note, score: relevance(note.text, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.note.id.localeCompare(right.note.id));
  const maxNotes = boundedPositive(options.maxNotes, 4);
  const maxBytes = boundedPositive(options.maxBytes, 6_000);
  const selected: RelevantMemoryNote[] = [];

  for (const entry of ranked.slice(0, maxNotes)) {
    const candidate = presentMemory(entry.note);
    const fitted = fitMemoryNote(candidate, selected, maxBytes);
    if (!fitted) continue;
    selected.push(fitted);
  }
  return ok(selected);
}

function presentMemory(note: MemoryNote): RelevantMemoryNote {
  return {
    id: note.id,
    text: note.text,
    createdAt: note.createdAt,
    provenance: note.provenance,
    source: `.visp/memory/${note.id}.md`,
    label: looksLikeAdvice(note.text) ? "advice" : "unverified-fact",
    verification: "unverified",
    freshness: "unknown",
  };
}

function fitMemoryNote(
  candidate: RelevantMemoryNote,
  selected: readonly RelevantMemoryNote[],
  maxBytes: number,
): RelevantMemoryNote | undefined {
  if (memoryBytes([...selected, candidate]) <= maxBytes) return candidate;
  if (!candidate.text.length) return undefined;

  let low = 1;
  let high = candidate.text.length;
  let best: RelevantMemoryNote | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const shortened = { ...candidate, text: candidate.text.slice(0, middle), truncated: true };
    if (memoryBytes([...selected, shortened]) <= maxBytes) {
      best = shortened;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

function memoryBytes(notes: readonly RelevantMemoryNote[]): number {
  return Buffer.byteLength(JSON.stringify(notes), "utf8");
}

function relevance(text: string, terms: readonly string[]): number {
  const normalized = text.toLowerCase();
  const noteTokens = new Set(tokenize(text));
  return terms.reduce((score, term) => {
    const phrase = term.toLowerCase().trim();
    if (!phrase) return score;
    const phraseHit = phrase.length >= 3 && normalized.includes(phrase) ? 2 : 0;
    const tokenHits = tokenize(term).reduce(
      (hits, token) => hits + (noteTokens.has(token) ? 1 : 0),
      0,
    );
    return score + phraseHit + tokenHits;
  }, 0);
}

function uniqueTokens(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const value of values) {
    for (const token of tokenize(value)) {
      if (seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

function tokenize(value: string): string[] {
  return (
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((token) => token.length > 2 && !MEMORY_STOPWORDS.has(token)) ?? []
  );
}

const MEMORY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "into",
  "with",
  "that",
  "this",
  "are",
  "use",
  "using",
  "file",
  "files",
  "src",
]);

function looksLikeAdvice(text: string): boolean {
  return /^(?:you should|prefer|avoid|always|never|use|do not|don't|make sure|remember|check|run|keep|consider)\b/i.test(
    text.trim(),
  );
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

async function readNote(
  files: ProjectFileSystem,
  directory: string,
  entry: string,
  needle: string | undefined,
): Promise<Result<MemoryNote | undefined>> {
  const text = await files.readTextIfExists(join(directory, entry));
  if (!text.ok) return text;
  if (text.value === undefined) return ok(undefined);

  const header = readHeader(text.value);
  const body = stripHeader(text.value);
  const verdict = screenNote(body, header.origin);

  if (verdict.release && needle && !body.toLowerCase().includes(needle)) return ok(undefined);

  return ok({
    id: entry.replace(/\.md$/, ""),
    text: verdict.release ? body : "",
    createdAt: header.createdAt,
    provenance: header.origin.kind,
    ...(verdict.release ? {} : { quarantined: verdict.reason }),
  });
}

/** The leading html comment `learn` writes, when the file opens with one. */
const HEADER = /^<!--([^>]*)-->\n?/;

/**
 * What a marker may say. Deliberately narrow: the source is echoed back in the
 * refusal that `visp recall` prints, and the file it comes from is one an
 * untrusted writer can reach, so a marker is a short bare word or nothing. A
 * header that does not fit is not a marker visp wrote, and the note is unknown.
 */
const MARKER = /\bprovenance=([A-Za-z0-9][A-Za-z0-9._-]{0,31})(?=\s|$)/;

interface Header {
  readonly createdAt: string;
  readonly origin: Origin;
}

/**
 * Reads what the file says about itself.
 *
 * Fields are matched within the opening comment rather than as one fixed line,
 * so that notes written before provenance existed still yield their timestamp,
 * and a person hand-editing a note — which the markdown format invites — can add
 * a marker without reproducing the rest of the line exactly.
 */
function readHeader(content: string): Header {
  const header = HEADER.exec(content)?.[1] ?? "";
  const createdAt = /\brecorded\s+(\S+)/.exec(header)?.[1] ?? "";
  const marker = MARKER.exec(header)?.[1];

  if (marker === undefined || marker === "unknown") {
    return { createdAt, origin: { kind: "unknown" } };
  }
  if (marker === "local") return { createdAt, origin: { kind: "local" } };
  return { createdAt, origin: { kind: "imported", source: marker } };
}

function stripHeader(content: string): string {
  return content.replace(HEADER, "").trim();
}
