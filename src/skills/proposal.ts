import { PRODUCT_NAME } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import { withStateMutation } from "../core/file-transaction.js";
import { type TaskRef, taskRefSchema } from "../core/identity.js";
import { err, ok, type Result } from "../core/result.js";
import { now } from "../workflow/artifacts/common.js";
import type { WorkspaceState } from "../workflow/state.js";
import { checkProposal } from "./admit.js";
import {
  readAppliesTo,
  SKILL_ORIGINS,
  type SkillOrigin,
  type SkillRecord,
  validateSkillId,
} from "./schema.js";
import {
  fingerprint,
  parseSkill,
  persistSkillRecord,
  readIndex,
  skillDescription,
  skillName,
  skillPath,
} from "./store.js";
import { type Support, supportFor, supportForRefs } from "./support.js";
import { revisionMutation, skillVersion } from "./versions.js";

export interface ProposalInput {
  readonly id: string;
  readonly fromTask?: string[];
  readonly sources?: readonly TaskRef[];
  readonly feature?: string;
  readonly by?: string;
  readonly origin?: string;
}

/** One checked persistence path for derived, imported, and bundled proposals. */
export async function createProposalFromContent(
  state: WorkspaceState,
  input: ProposalInput,
  content: string,
): Promise<Result<SkillRecord>> {
  return withStateMutation(state.paths.root, () => proposeLocked(state, input, content));
}

async function proposeLocked(
  state: WorkspaceState,
  input: ProposalInput,
  content: string,
): Promise<Result<SkillRecord>> {
  const checkedId = validateSkillId(input.id);
  if (!checkedId.ok) return checkedId;
  const id = checkedId.value;
  const index = await readIndex(state);
  if (!index.ok) return index;
  const existing = index.value.skills.find((skill) => skill.id === id);
  if (existing?.state === "admitted") {
    return err(
      vispError(
        "UNSUPPORTED",
        `${id} is admitted; retire it with a reason before proposing a replacement`,
      ),
    );
  }

  const origin = SKILL_ORIGINS.find((candidate) => candidate === input.origin);
  if (!origin) {
    return err(
      vispError(
        "UNSUPPORTED",
        `Unknown origin "${input.origin}". Use one of: ${SKILL_ORIGINS.join(", ")}`,
      ),
    );
  }

  const document = parseSkill(content);
  if (!document.ok) return document;
  const sources = await resolveSources(state, input);
  if (!sources.ok) return sources;
  const { derivedFrom, support } = sources.value;
  const checked = checkProposal({
    frontmatter: document.value.frontmatter,
    body: document.value.body,
    derivedFrom,
    minSupport: state.config.skills.minSupport,
    supportedBy: support.closed,
    origin,
  });
  if (!checked.ok) {
    return err(
      vispError(
        "SCOPE_VIOLATION",
        `${id} cannot be proposed:\n${checked.reasons.map((reason) => `  - ${reason}`).join("\n")}`,
        { recovery: `${PRODUCT_NAME} skill list` },
      ),
    );
  }

  const appliesTo = readAppliesTo(document.value.frontmatter);
  const record: SkillRecord = {
    id,
    name: skillName(document.value, id),
    description: skillDescription(document.value),
    state: "proposed",
    trust: checked.trust,
    evidence: checked.evidence,
    origin: origin as SkillOrigin,
    derivedFrom: support.snapshots.map((source) => source.task),
    support: support.snapshots,
    minSupport: state.config.skills.minSupport,
    ...(appliesTo.ok && appliesTo.value ? { appliesTo: appliesTo.value } : {}),
    ...(input.feature ? { feature: input.feature } : {}),
    ...(input.by ? { proposedBy: input.by } : {}),
    contentHash: fingerprint(content),
    createdAt: now(),
  };
  const versioned = { ...record, version: skillVersion(record, content) };
  const revision = await revisionMutation(state, versioned, content);
  if (!revision.ok) return revision;
  const stored = await persistSkillRecord(state, versioned, [
    ...revision.value,
    { kind: "write", path: skillPath(state, id), content },
  ]);
  return stored.ok ? ok(versioned) : stored;
}

async function resolveSources(
  state: WorkspaceState,
  input: ProposalInput,
): Promise<Result<{ derivedFrom: string[]; support: Support }>> {
  if (input.sources && ((input.fromTask?.length ?? 0) > 0 || input.feature))
    return err(
      vispError("ARTIFACT_INVALID", "Use qualified sources or --feature/--from-task, not both"),
    );
  if (input.sources?.some((source) => !taskRefSchema.safeParse(source).success))
    return err(vispError("ARTIFACT_INVALID", "A skill source must name a valid feature and task"));
  const derivedFrom =
    input.sources?.map((source) => `${source.feature}/${source.task}`) ?? input.fromTask ?? [];
  const support = input.sources
    ? await supportForRefs(state, input.sources)
    : await supportFor(state, input.feature, derivedFrom);
  return ok({ derivedFrom, support });
}
