import { PRODUCT_NAME } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import { withStateMutation } from "../core/file-transaction.js";
import { hashValue } from "../core/hash.js";
import { err, ok, type Result } from "../core/result.js";
import { now } from "../workflow/artifacts/common.js";
import type { WorkspaceState } from "../workflow/state.js";
import { checkProposal } from "./admit.js";
import { type SkillRecord, validateSkillId } from "./schema.js";
import {
  fingerprint,
  parseSkill,
  persistSkillRecord,
  readIndex,
  readSkillBody,
  readSkillHistory,
  skillPath,
} from "./store.js";
import { currentSupport } from "./support.js";
import { revisionMutation, skillVersion } from "./versions.js";

export interface SkillTransitionInput {
  /** A claimed reviewer name; local admission does not authenticate identity. */
  readonly by?: string;
  readonly reason?: string;
}

export async function findSkill(state: WorkspaceState, id: string): Promise<Result<SkillRecord>> {
  const checked = validateSkillId(id);
  if (!checked.ok) return checked;
  const index = await readIndex(state);
  if (!index.ok) return index;
  const found = index.value.skills.find((skill) => skill.id === id);
  return found
    ? ok(found)
    : err(
        vispError("ARTIFACT_MISSING", `No skill named ${id}`, {
          recovery: `${PRODUCT_NAME} skill list`,
        }),
      );
}

export async function validateSkillForAdmission(
  state: WorkspaceState,
  record: SkillRecord,
  content: string,
): Promise<Result<SkillRecord>> {
  if (fingerprint(content) !== record.contentHash)
    return err(
      vispError("ARTIFACT_INVALID", `${record.id} was edited since it was proposed`, {
        recovery: `${PRODUCT_NAME} skill diff ${record.id}`,
      }),
    );
  if (record.version && skillVersion(record, content) !== record.version) {
    return err(
      vispError(
        "ARTIFACT_INVALID",
        `${record.id} revision no longer matches its support or applicability`,
      ),
    );
  }
  const document = parseSkill(content);
  if (!document.ok) return document;
  const support = await currentSupport(state, record);
  const derivedFrom =
    record.support?.map((source) => `${source.feature}/${source.task}`) ?? record.derivedFrom;
  const checked = checkProposal({
    ...document.value,
    derivedFrom,
    minSupport: Math.max(record.minSupport ?? 1, state.config.skills.minSupport),
    supportedBy: support.closed,
    origin: record.origin,
  });
  if (!checked.ok)
    return err(
      vispError(
        "SCOPE_VIOLATION",
        `${record.id} cannot be admitted:\n${checked.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
      ),
    );
  if (record.evidence?.usefulness === "harmful")
    return err(
      vispError(
        "UNSUPPORTED",
        `${record.id} has a harmful reviewed assessment; revise and evaluate it before activation`,
      ),
    );
  const history = await readSkillHistory(state, record.id);
  if (!history.ok) return history;
  if (
    record.version &&
    history.value.some(
      (event) =>
        event.record.version === record.version && event.record.evidence?.usefulness === "harmful",
    )
  ) {
    return err(
      vispError(
        "UNSUPPORTED",
        `${record.id} revision has harmful reviewed evidence; propose a revised version`,
      ),
    );
  }
  // Legacy records acquire explicit local provenance only during reviewed admission.
  const candidate = {
    ...record,
    trust: checked.trust,
    support: support.snapshots,
    minSupport: record.minSupport ?? state.config.skills.minSupport,
    evidence: record.evidence ?? checked.evidence,
  };
  return ok({ ...candidate, version: record.version ?? skillVersion(candidate, content) });
}

export async function transitionSkill(
  state: WorkspaceState,
  id: string,
  next: "admitted" | "rejected" | "retired",
  input: SkillTransitionInput,
): Promise<Result<SkillRecord>> {
  return withStateMutation(state.paths.root, async () => {
    const found = await findSkill(state, id);
    if (!found.ok) return found;
    const current = found.value;
    const checked = validateTransition(current, next, input);
    if (!checked.ok) return checked;
    if (next !== "admitted")
      return persistTransition(state, { ...current, state: next, reason: input.reason });

    const content = await readSkillBody(state, id);
    if (!content.ok) return content;
    if (content.value === undefined)
      return err(vispError("ARTIFACT_MISSING", `${id} has no SKILL.md on disk`));
    const validated = await validateSkillForAdmission(state, current, content.value);
    if (!validated.ok) return validated;
    return activateSkill(state, validated.value, content.value, input);
  });
}

function validateTransition(
  current: SkillRecord,
  next: "admitted" | "rejected" | "retired",
  input: SkillTransitionInput,
): Result<void> {
  const allowed = {
    admitted: ["proposed", "orphaned"],
    rejected: ["proposed"],
    retired: ["admitted", "orphaned"],
  };
  if (!allowed[next].includes(current.state))
    return err(
      vispError("UNSUPPORTED", `${current.id} is ${current.state}; cannot transition to ${next}`),
    );
  if (next === "admitted" && !input.by?.trim())
    return err(vispError("UNSUPPORTED", "Reviewed admission requires --by"));
  if (next !== "admitted" && !input.reason?.trim())
    return err(vispError("UNSUPPORTED", "Retirement and rejection require a reason"));
  return ok(undefined);
}

export async function activateSkill(
  state: WorkspaceState,
  candidate: SkillRecord,
  content: string,
  input: SkillTransitionInput,
): Promise<Result<SkillRecord>> {
  const { reason: _previousReason, ...rest } = candidate;
  const record: SkillRecord = {
    ...rest,
    state: "admitted",
    admittedBy: input.by,
    admittedAt: now(),
    ...(input.reason ? { reason: input.reason } : {}),
  };
  const revision = await revisionMutation(state, record, content);
  if (!revision.ok) return revision;
  const stored = await persistSkillRecord(state, record, [
    ...revision.value,
    { kind: "write", path: skillPath(state, record.id), content },
  ]);
  return stored.ok ? ok(record) : stored;
}

async function persistTransition(
  state: WorkspaceState,
  record: SkillRecord,
): Promise<Result<SkillRecord>> {
  const stored = await persistSkillRecord(state, record);
  return stored.ok ? ok(record) : stored;
}

/** Frozen selection for an experiment, keyed by content and applicability version. */
export async function skillSelectionSnapshot(state: WorkspaceState): Promise<
  Result<{
    schemaVersion: 1;
    digest: string;
    skills: Array<{ id: string; version: string }>;
  }>
> {
  const index = await readIndex(state);
  if (!index.ok) return index;
  const skills: Array<{ id: string; version: string }> = [];
  for (const record of index.value.skills.filter((skill) => skill.state === "admitted")) {
    const content = await readSkillBody(state, record.id);
    if (!content.ok) return content;
    if (content.value === undefined)
      return err(vispError("ARTIFACT_MISSING", `${record.id} has no skill file`));
    const checked = await validateSkillForAdmission(state, record, content.value);
    if (!checked.ok) return checked;
    if (checked.value.version) skills.push({ id: record.id, version: checked.value.version });
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return ok({ schemaVersion: 1, digest: hashValue(skills), skills });
}
