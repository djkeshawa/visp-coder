import { join } from "node:path";
import { z } from "zod";
import { vispError } from "../core/errors.js";
import type { FileMutation } from "../core/file-transaction.js";
import { hashValue, sha256 } from "../core/hash.js";
import { err, ok, type Result } from "../core/result.js";
import { sha256Schema } from "../workflow/artifacts/common.js";
import type { WorkspaceState } from "../workflow/state.js";
import { type SkillRecord, skillRecordSchema, validateSkillId } from "./schema.js";

const revisionSchema = z
  .object({
    kind: z.literal("skill-revision"),
    schemaVersion: z.literal(1),
    version: sha256Schema,
    record: skillRecordSchema,
    content: z.string(),
  })
  .strict();
export type SkillRevision = z.infer<typeof revisionSchema>;

/** A revision binds the full source document and the exact claimed support. */
export function skillVersion(record: SkillRecord, content: string): string {
  return hashValue({
    schemaVersion: 1,
    id: record.id,
    content: sha256(content),
    origin: record.origin,
    derivedFrom: record.derivedFrom,
    feature: record.feature,
    support: record.support,
    minSupport: record.minSupport,
    appliesTo: record.appliesTo,
  });
}

function revisionPath(state: WorkspaceState, id: string, version: string): Result<string> {
  const checkedId = validateSkillId(id);
  if (!checkedId.ok) return checkedId;
  if (!sha256Schema.safeParse(version).success)
    return err(vispError("ARTIFACT_INVALID", "Skill version must be a full sha256 digest"));
  return ok(join(state.paths.state, "skills", checkedId.value, "revisions", `${version}.json`));
}

export async function readSkillRevision(
  state: WorkspaceState,
  id: string,
  version: string,
): Promise<Result<SkillRevision | undefined>> {
  const path = revisionPath(state, id, version);
  if (!path.ok) return path;
  return state.files.readJsonIfExists(path.value, (value) => {
    const parsed = revisionSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.version !== version ||
      parsed.data.record.id !== id ||
      parsed.data.record.version !== version ||
      skillVersion(parsed.data.record, parsed.data.content) !== version
    ) {
      return err(
        vispError("ARTIFACT_INVALID", `Invalid or tampered skill revision ${id}@${version}`),
      );
    }
    return ok(parsed.data);
  });
}

export async function revisionMutation(
  state: WorkspaceState,
  record: SkillRecord,
  content: string,
): Promise<Result<FileMutation[]>> {
  if (!record.version || skillVersion(record, content) !== record.version) {
    return err(
      vispError("ARTIFACT_INVALID", "Skill revision does not match its content and support"),
    );
  }
  const existing = await readSkillRevision(state, record.id, record.version);
  if (!existing.ok) return existing;
  if (existing.value) return ok([]);
  const path = revisionPath(state, record.id, record.version);
  if (!path.ok) return path;
  const revision: SkillRevision = {
    kind: "skill-revision",
    schemaVersion: 1,
    version: record.version,
    record,
    content,
  };
  return ok([
    {
      kind: "write",
      path: path.value,
      content: `${JSON.stringify(revision, null, 2)}\n`,
      expectedBefore: { existed: false },
    },
  ]);
}
