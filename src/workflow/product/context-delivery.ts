import { join } from "node:path";
import type { FileMutation } from "../../core/file-transaction.js";
import { filePrecondition } from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { estimateProductContextTokens } from "./context-budget.js";
import type { ProductWorkContext } from "./context-types.js";
import { currentHostSession } from "./host-prompts.js";

/**
 * What a `work` reply delivered to one host session, so re-authorizing the same unchanged slice
 * in that session does not repeat material the worker already has. Only reference material is
 * left out: the request, outcomes, scope, checks, findings, feedback and next step are in every
 * reply. A new session, an unknown session and `work --inspect` always get the full pack.
 */

/** Reference sections a worker keeps from an earlier reply in the same session. */
const REPEATABLE = [
  "files",
  "graph",
  "memory",
  "skills",
  "examples",
  "decisions",
  "acceptanceBaseline",
  "projectMemory",
] as const;
type Repeatable = (typeof REPEATABLE)[number];

interface ContextDelivery {
  readonly session: string;
  readonly task: string;
  readonly contractDigest: string;
  readonly sections: Partial<Record<Repeatable, string>>;
}

export interface PlannedDelivery {
  /** The reply to send: the full context, or the full context less unchanged sections. */
  readonly context: ProductWorkContext;
  /** Records this delivery; absent when the session is unknown. */
  readonly mutation?: FileMutation;
}

/**
 * The session a reply goes to: the MCP server process the host started, the Codex thread
 * running this command, or the host session that sent the latest prompt (when only one is
 * active). Undefined when none is known, which always sends the full pack.
 */
async function deliverySession(
  workspace: WorkspaceState,
  requested?: string,
): Promise<Result<string | undefined>> {
  if (requested) return ok(requested);
  const thread = process.env.CODEX_THREAD_ID;
  if (thread && /^[A-Za-z0-9-]+$/u.test(thread)) return ok(`codex:${thread}`);
  const host = await currentHostSession(workspace, true);
  if (!host.ok) return host;
  return ok(host.value ? `host:${host.value}` : undefined);
}

export async function planDelivery(
  workspace: WorkspaceState,
  context: ProductWorkContext,
  contractDigest: string,
  options: { readonly deliverySession?: string },
): Promise<Result<PlannedDelivery>> {
  const identified = await deliverySession(workspace, options.deliverySession);
  if (!identified.ok) return identified;
  const session = identified.value;
  if (!session) return ok({ context });
  const path = deliveryPath(workspace, context.feature);
  const before = await workspace.files.readTextIfExists(path);
  if (!before.ok) return before;
  const record: ContextDelivery = {
    session,
    task: context.task,
    contractDigest,
    sections: sectionDigests(context),
  };
  const mutation: FileMutation = {
    kind: "write",
    path,
    content: `${JSON.stringify(record, null, 2)}\n`,
    expectedBefore: filePrecondition(before.value),
  };
  const previous = parseDelivery(before.value);
  const sameDelivery =
    previous?.session === session &&
    previous.task === context.task &&
    previous.contractDigest === contractDigest;
  if (!sameDelivery) return ok({ context, mutation });
  const unchanged = REPEATABLE.filter(
    (section) =>
      record.sections[section] !== undefined &&
      record.sections[section] === previous.sections[section],
  );
  if (unchanged.length === 0) return ok({ context, mutation });
  return ok({ context: withoutSections(context, unchanged), mutation });
}

function deliveryPath(workspace: WorkspaceState, feature: string): string {
  return join(workspace.paths.sessionDir, "deliveries", `${feature}.json`);
}

/** Digests of the non-empty reference sections; an empty one costs nothing to resend. */
function sectionDigests(context: ProductWorkContext): Partial<Record<Repeatable, string>> {
  const digests: Partial<Record<Repeatable, string>> = {};
  for (const section of REPEATABLE) {
    const value = context[section];
    if (Array.isArray(value) && value.length > 0) digests[section] = hashValue(value);
  }
  return digests;
}

function withoutSections(
  context: ProductWorkContext,
  unchanged: readonly Repeatable[],
): ProductWorkContext {
  const reduced: ProductWorkContext = {
    ...context,
    ...Object.fromEntries(unchanged.map((section) => [section, []])),
    delivery: { unchanged },
  };
  const priced = { ...reduced, budget: { ...reduced.budget, estimatedTokens: 0 } };
  return {
    ...priced,
    budget: { ...priced.budget, estimatedTokens: estimateProductContextTokens(priced) },
  };
}

function parseDelivery(text: string | undefined): ContextDelivery | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<ContextDelivery>;
    return typeof parsed.session === "string" &&
      typeof parsed.task === "string" &&
      typeof parsed.contractDigest === "string" &&
      typeof parsed.sections === "object" &&
      parsed.sections !== null
      ? (parsed as ContextDelivery)
      : undefined;
  } catch {
    // A damaged record only means the next reply is complete.
    return undefined;
  }
}
