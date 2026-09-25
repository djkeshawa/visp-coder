import { resolveCommand } from "../core/exec.js";
import { readAppliesTo, type SkillEvidence, type SkillOrigin, type SkillTrust } from "./schema.js";

/**
 * What a proposal must satisfy before it can become a skill.
 *
 * The research this follows is blunt about the reason. A safety judge catches
 * most poisoned material while it is still a raw trajectory and almost none of
 * it once it has been distilled into a tidy procedure: summarising launders the
 * payload. So nothing here tries to decide whether a skill is well intentioned.
 * It checks that the skill can be traced to work that actually happened, that
 * its claims can be run, and that it asks for no authority — and leaves the
 * judgement to a person.
 */

export interface ProposalCheck {
  readonly ok: boolean;
  readonly reasons: string[];
  readonly trust: SkillTrust;
  readonly evidence: SkillEvidence;
}

/**
 * Directives a skill may not carry. Not a list of suspicious words: each of
 * these is a specific claim on authority that comes from the task graph, the
 * policy, or the evidence record, and never from prose.
 */
const FORBIDDEN_DIRECTIVES: readonly { readonly pattern: RegExp; readonly claim: string }[] = [
  { pattern: /\ballowed[_\s-]?files\b/i, claim: "sets the files a task may write" },
  { pattern: /\bforbidden[_\s-]?files\b/i, claim: "sets the files a task may not write" },
  {
    pattern: /\bvalidation[_\s-]?commands\b/i,
    claim: "adds a command that would count as evidence",
  },
  { pattern: /\bvisp\s+override\b/i, claim: "records an exception" },
  { pattern: /\bvisp\s+policy\s+(set|set-strictness)\b/i, claim: "changes which rules apply" },
  { pattern: /\bstrictness\b/i, claim: "changes how firmly gates refuse" },
  { pattern: /\bskip\b[^.\n]{0,30}\b(gate|check|verify|review)\b/i, claim: "skips a check" },
  {
    pattern:
      /\b(ignore|override|disregard)\b[^.\n]{0,30}\b(previous|prior|system|developer)\b[^.\n]{0,20}\b(instructions?|rules?|policy)\b/i,
    claim: "overrides host instructions",
  },
  {
    pattern:
      /--(?:no-verify|dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox)\b/i,
    claim: "bypasses execution controls",
  },
];

/** Frontmatter keys that would carry the same claims in structured form. */
const FORBIDDEN_KEYS = [
  "allowedfiles",
  "forbiddenfiles",
  "validationcommands",
  "policy",
  "strictness",
  "overrides",
  "permissions",
  "sandbox",
  "autoadmit",
  "executionpolicy",
];

export interface Proposal {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
  /** Closed task ids this was distilled from. */
  readonly derivedFrom: readonly string[];
  /** How many distinct closed tasks are required. */
  readonly minSupport: number;
  /** Of `derivedFrom`, the ones currently recorded as closed local tasks. */
  readonly supportedBy: readonly string[];
  /** Defaults to `derived`, so an omitted origin is the demanding one. */
  readonly origin?: SkillOrigin;
}

export function checkProposal(proposal: Proposal): ProposalCheck {
  const reasons: string[] = [];
  const origin = proposal.origin ?? "derived";

  // Support. Two runs of the same task is one occasion, so distinct ids only.
  //
  // Seeded knowledge is exempt because the check does not apply to it, not
  // because it is trusted more: there is no local work behind a lesson brought
  // in from outside, and requiring three task ids anyway would only teach
  // people to name three. What it is exempt from is evidence of provenance;
  // everything below still holds, and a person still has to admit it.
  const cited = new Set(proposal.derivedFrom);
  const support = new Set(proposal.supportedBy.filter((id) => cited.has(id)));
  if (origin === "derived" && support.size < proposal.minSupport) {
    reasons.push(
      `Cites ${support.size} closed task(s), and ${proposal.minSupport} are required. ` +
        "A skill drawn from one occasion is a guess about the next one.",
    );
  }

  // Seeded and citing local work is a contradiction, and one that would outlive
  // itself: nothing reconciles a seeded skill's lineage, so work named here
  // would go on being cited long after it stopped being closed.
  if (origin === "seeded" && proposal.derivedFrom.length > 0) {
    reasons.push(
      `Is seeded but cites ${proposal.derivedFrom.join(", ")}. Seeded knowledge comes ` +
        "from outside this project; a skill drawn from work here is derived.",
    );
  }

  // Applies to both origins: naming work that was never finished is a false
  // claim about this project whoever is making it.
  const unknown = proposal.derivedFrom.filter((id) => !support.has(id));
  if (unknown.length > 0) {
    reasons.push(
      `Names ${unknown.join(", ")}, which are not closed tasks in this project's graph.`,
    );
  }

  const appliesTo = readAppliesTo(proposal.frontmatter);
  if (!appliesTo.ok) reasons.push(appliesTo.error.message);

  // Containment. Refused rather than flagged: a skill carrying authority must
  // not exist, because once it exists the question becomes whether anyone reads
  // it carefully, and that is not a property the tool can hold.
  reasons.push(...forbiddenClaims(proposal));

  const declaredCommand = verificationCommand(proposal.body);
  return {
    ok: reasons.length === 0,
    reasons,
    trust: declaredCommand ? "declared" : "advisory",
    evidence: {
      verification: { ...(declaredCommand ? { declaredCommand } : {}), execution: "not-run" },
      provenance: origin === "derived" ? "local-recorded" : "external-unverified",
      usefulness: "unmeasured",
      usefulnessBasis: "unmeasured",
    },
  };
}

export function forbiddenClaims(proposal: Pick<Proposal, "frontmatter" | "body">): string[] {
  const { found, text } = frontmatterClaims(proposal.frontmatter);
  const normalized = normalizeClaim([proposal.body, ...text].join("\n"));
  for (const directive of FORBIDDEN_DIRECTIVES) {
    if (directive.pattern.test(normalized)) {
      found.push(`Its body ${directive.claim}, which comes from the task graph, not from a skill.`);
    }
  }
  return found;
}

function frontmatterClaims(frontmatter: Record<string, unknown>): {
  found: string[];
  text: string[];
} {
  const found: string[] = [];
  const seen = new Set<object>();
  const text: string[] = [];
  const pending: Array<{ value: unknown; path: string }> = [{ value: frontmatter, path: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current?.value || typeof current.value !== "object" || seen.has(current.value)) continue;
    seen.add(current.value);
    for (const [key, value] of Object.entries(current.value)) {
      const path = current.path ? `${current.path}.${key}` : key;
      if (FORBIDDEN_KEYS.includes(normalizeClaim(key).toLowerCase().replace(/[_-]/g, ""))) {
        found.push(`Its frontmatter sets "${path}", which a skill cannot decide.`);
      }
      pending.push({ value, path });
      if (typeof value === "string") text.push(value);
    }
  }

  return { found, text };
}

function normalizeClaim(text: string): string {
  return text.normalize("NFKC").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "");
}

/**
 * A syntactically valid command under a `Verification` heading. It is not executed.
 *
 * It must be written as code — a backtick span or a fenced block. Parsing alone
 * is not enough of a test: "see below" splits into a perfectly good argv, and
 * accepting that would hand `declared` to any sentence with no punctuation in
 * it. A skill that cannot say how it would be checked is still worth keeping;
 * it is simply not evidence of anything.
 */
export function verificationCommand(body: string): string | undefined {
  const section = /^#{1,6}\s*verification\s*$/im.exec(body);
  if (!section) return undefined;

  const rest = body.slice(section.index + section[0].length);
  const end = /^#{1,6}\s/m.exec(rest);
  const block = end ? rest.slice(0, end.index) : rest;

  let inFence = false;

  for (const raw of block.split("\n")) {
    const line = raw.trim();

    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }

    const candidate = inFence ? line : (/^(?:[-*]\s*)?`([^`]+)`\s*$/.exec(line)?.[1]?.trim() ?? "");

    if (candidate === "") continue;
    if (resolveCommand(candidate).ok) return candidate;
  }

  return undefined;
}
