import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { FILE } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  withStateMutation,
} from "../core/file-transaction.js";
import { ProjectFileSystem } from "../core/fs.js";
import { hashValue, sha256 } from "../core/hash.js";
import { isInside } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import { isoTimestampSchema, now, sha256Schema } from "../workflow/artifacts/common.js";
import type { WorkspaceState } from "../workflow/state.js";
import {
  type SkillIndex,
  type SkillRecord,
  skillIndexSchema,
  skillRecordSchema,
  validateSkillId,
} from "./schema.js";

const transitionSchema = z
  .object({
    kind: z.literal("skill-transition"),
    schemaVersion: z.literal(1),
    at: isoTimestampSchema,
    previousHash: sha256Schema.nullable(),
    record: skillRecordSchema,
  })
  .strict();
export type SkillTransition = z.infer<typeof transitionSchema>;

/**
 * Skills on disk: a markdown file a person can read, and an index recording
 * where each one came from.
 *
 * Tracked rather than derived. A skill is something the project learned, so it
 * belongs to the project — and a reviewer seeing one arrive in a diff is part
 * of how it stays accountable.
 */

export interface SkillDocument {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

export function skillsDir(state: WorkspaceState): string {
  return join(state.paths.state, "skills");
}

function skillRoot(state: WorkspaceState): string {
  return resolve(skillsDir(state));
}

export function skillPath(state: WorkspaceState, id: string): string {
  const paths = lexicalSkillPaths(state, id);
  if (!paths.ok) throw new Error(paths.error.message);
  return paths.value.file;
}

interface SkillPaths {
  readonly root: string;
  readonly directory: string;
  readonly file: string;
}

function lexicalSkillPaths(state: WorkspaceState, id: string): Result<SkillPaths> {
  const checked = validateSkillId(id);
  if (!checked.ok) return checked;

  const root = skillRoot(state);
  const directory = resolve(root, checked.value);
  const file = resolve(directory, "SKILL.md");
  return isInside(root, file)
    ? ok({ root, directory, file })
    : err(vispError("UNSUPPORTED", `Skill id "${id}" resolves outside .visp/skills`));
}

function lexicalIndexPaths(state: WorkspaceState): Result<{ root: string; file: string }> {
  const root = skillRoot(state);
  const file = resolve(root, FILE.skills);
  return isInside(root, file)
    ? ok({ root, file })
    : err(vispError("UNSUPPORTED", `${FILE.skills} resolves outside .visp/skills`));
}

function checkedIndexPath(state: WorkspaceState): Result<string> {
  const paths = lexicalIndexPaths(state);
  if (!paths.ok) return paths;
  return ok(paths.value.file);
}

export async function readIndex(state: WorkspaceState): Promise<Result<SkillIndex>> {
  const path = checkedIndexPath(state);
  if (!path.ok) return path;

  const text = await projectFiles(state).readTextIfExists(path.value);
  if (!text.ok) return text;
  if (text.value === undefined) return ok({ kind: "skills", createdAt: now(), skills: [] });

  try {
    const parsed = skillIndexSchema.safeParse(JSON.parse(text.value));
    return parsed.success
      ? ok({ ...parsed.data, skills: parsed.data.skills.map(normalizeLegacyEvidence) })
      : err(vispError("ARTIFACT_INVALID", `Invalid ${FILE.skills}: ${parsed.error.message}`));
  } catch {
    return err(vispError("ARTIFACT_INVALID", `${FILE.skills} is not valid JSON`));
  }
}

function normalizeLegacyEvidence(record: SkillRecord): SkillRecord {
  if (record.trust !== "verified") return record;
  return {
    ...record,
    trust: "declared",
    evidence: record.evidence ?? {
      verification: { execution: "unknown" },
      provenance: "unknown",
      usefulness: "unmeasured",
      usefulnessBasis: "unknown",
    },
  };
}

export async function writeIndex(state: WorkspaceState, index: SkillIndex): Promise<Result<void>> {
  const path = checkedIndexPath(state);
  return path.ok ? projectFiles(state).writeJson(path.value, index) : path;
}

export async function upsert(state: WorkspaceState, record: SkillRecord): Promise<Result<void>> {
  return persistSkillRecord(state, record);
}

/** The immutable transition and its current projection commit together. */
export async function persistSkillRecord(
  state: WorkspaceState,
  record: SkillRecord,
  mutations: readonly FileMutation[] = [],
): Promise<Result<void>> {
  return withStateMutation(state.paths.root ?? dirname(state.paths.state), () =>
    persistLocked(state, record, mutations),
  );
}

async function persistLocked(
  state: WorkspaceState,
  record: SkillRecord,
  mutations: readonly FileMutation[],
): Promise<Result<void>> {
  const index = await readIndex(state);
  if (!index.ok) return index;
  const checked = validateSkillId(record.id);
  if (!checked.ok) return checked;
  const path = checkedIndexPath(state);
  if (!path.ok) return path;
  const previous = index.value.skills.find((skill) => skill.id === record.id);
  if (previous && hashValue(previous) === hashValue(record) && mutations.length === 0)
    return ok(undefined);
  const skills = index.value.skills.filter((skill) => skill.id !== record.id);
  const event = {
    kind: "skill-transition",
    schemaVersion: 1,
    at: now(),
    previousHash: previous ? hashValue(previous) : null,
    record,
  };
  const eventPath = join(skillsDir(state), record.id, "history", `${hashValue(event)}.json`);
  const changed = await applyFileTransaction(
    state.paths.root ?? dirname(state.paths.state),
    "record skill transition",
    [
      ...mutations,
      {
        kind: "write",
        path: eventPath,
        content: `${JSON.stringify(event, null, 2)}\n`,
        expectedBefore: { existed: false },
      },
      {
        kind: "write",
        path: path.value,
        content: `${JSON.stringify({ ...index.value, skills: [...skills, record] }, null, 2)}\n`,
      },
    ],
  );
  return changed.ok ? ok(undefined) : changed;
}

export async function readSkillHistory(
  state: WorkspaceState,
  id: string,
): Promise<Result<SkillTransition[]>> {
  const checked = validateSkillId(id);
  if (!checked.ok) return checked;
  const directory = join(skillsDir(state), id, "history");
  const names = await projectFiles(state).listDir(directory);
  if (!names.ok) return names;
  const history: SkillTransition[] = [];
  for (const name of names.value) {
    if (!/^[a-f0-9]{64}\.json$/.test(name))
      return err(vispError("ARTIFACT_INVALID", `Unexpected skill history entry ${name}`));
    const event = await projectFiles(state).readJsonIfExists(join(directory, name), (raw) => {
      const parsed = transitionSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.record.id !== id ||
        `${hashValue(parsed.data)}.json` !== name
      ) {
        return err(vispError("ARTIFACT_INVALID", `Invalid or tampered skill transition ${name}`));
      }
      return ok(parsed.data);
    });
    if (!event.ok) return event;
    if (event.value) history.push(event.value);
  }
  return ok(history.sort((a, b) => a.at.localeCompare(b.at)));
}

export async function readSkillBody(
  state: WorkspaceState,
  id: string,
): Promise<Result<string | undefined>> {
  const paths = lexicalSkillPaths(state, id);
  return paths.ok ? projectFiles(state).readTextIfExists(paths.value.file) : paths;
}

export async function writeSkillBody(
  state: WorkspaceState,
  id: string,
  content: string,
): Promise<Result<void>> {
  const paths = lexicalSkillPaths(state, id);
  return paths.ok ? projectFiles(state).writeTextAtomic(paths.value.file, content) : paths;
}

function projectFiles(state: WorkspaceState): ProjectFileSystem {
  return state.files ?? new ProjectFileSystem(dirname(state.paths.state));
}

export function fingerprint(content: string): string {
  return sha256(content).slice(0, 12);
}

/**
 * Splits YAML frontmatter from the body. A file without frontmatter is all
 * body, which is a proposal with no metadata rather than an error. A frontmatter
 * opener must have a closing delimiter and a YAML mapping that can be screened.
 */
export function parseSkill(content: string): Result<SkillDocument> {
  const opening = /^---\r?\n/.exec(content);
  if (!opening) return ok({ frontmatter: {}, body: content });

  const rest = content.slice(opening[0].length);
  const closing = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(rest);
  if (!closing) {
    return err(vispError("ARTIFACT_INVALID", "Skill frontmatter is not closed with ---"));
  }

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = parseYaml(rest.slice(0, closing.index)) as unknown;
    if (parsed === null || parsed === undefined) {
      frontmatter = {};
    } else if (typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    } else {
      return err(vispError("ARTIFACT_INVALID", "Skill frontmatter must be a YAML mapping"));
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(vispError("ARTIFACT_INVALID", `Skill frontmatter is not valid YAML: ${message}`));
  }

  return ok({
    frontmatter,
    body: content.slice(opening[0].length + closing.index + closing[0].length),
  });
}

function stringField(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function skillName(document: SkillDocument, fallback: string): string {
  return stringField(document.frontmatter, "name") ?? fallback;
}

export function skillDescription(document: SkillDocument): string {
  return stringField(document.frontmatter, "description") ?? "";
}
