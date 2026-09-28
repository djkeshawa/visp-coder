import { join } from "node:path";
import { z } from "zod";
import { hashValue } from "../../core/hash.js";
import type { WorkspaceState } from "../state.js";

/**
 * Disputes of pinned acceptance tests. The worker cannot edit the pinned suite, and a suite
 * can itself be wrong (an assertion about incidental key order, a case the request defines
 * differently). A worker may dispute a failing test with a reason quoting the request; the
 * independent reviewer rules. An upheld test is waived: VISP tells the suite to skip it
 * through `VISP_WAIVED_TESTS`, and a suite that cannot skip it is treated as passing when
 * every failing test it names is waived. This leaf module holds the record shape and the pure
 * helpers that the check runner, the tester and the reviewer share.
 */

/** The tester's record in a feature's directory; disputes live beside the pinned suite. */
export const TESTS_RECORD = "acceptance-tests.json";
/** JSON array of waived test names, given to every run of the pinned suite. */
export const WAIVED_TESTS_ENV = "VISP_WAIVED_TESTS";
/** Most disputes that may await a ruling at once, and most tests one call may dispute. */
export const MAX_OPEN_DISPUTES = 5;
export const MIN_REASON_LENGTH = 20;
/** A dispute is filed at most this often per test, and reviewed at most this often per filing. */
export const MAX_FILINGS_PER_TEST = 2;
export const MAX_REVIEWS_PER_FILING = 2;

const rulingRecord = z
  .object({
    ruling: z.enum(["upheld", "rejected"]),
    reasoning: z.string(),
    at: z.string(),
    /** Product source digest the reviewer ruled on. */
    subject: z.string(),
    model: z.string().optional(),
    /** The critic attempt that returned it; an upheld ruling is verified against it. */
    attempt: z.string(),
    /** The critic selection's task, which locates that attempt's state file. */
    task: z.string().optional(),
    evidence: z.string(),
  })
  .strict();
export type DisputeRulingRecord = z.infer<typeof rulingRecord>;

export const disputeSchema = z
  .object({
    /** The tester's name for the test, as declared in the record's `tests`. */
    test: z.string(),
    check: z.string(),
    reason: z.string(),
    filedAt: z.string(),
    /** Product source digest of the failing run described by `failure`. */
    subject: z.string(),
    /** Tail of that failing run. */
    failure: z.string(),
    status: z.enum(["open", "upheld", "rejected", "expired"]),
    /** Times the worker filed this test; a re-roll is capped. */
    filings: z.number().int().default(1),
    /** Independent reviews of this filing that left it without a ruling. */
    reviews: z.number().int().default(0),
    ruling: rulingRecord.optional(),
    /** Rulings of earlier filings, shown to the reviewer of a later one. */
    history: z.array(rulingRecord).default([]),
  })
  .strict();
export type PinnedDispute = z.infer<typeof disputeSchema>;

/** Lines that show an uncaught error or a stack trace rather than a reported test failure. */
const UNCAUGHT =
  /^\s*(?:Traceback \(most recent call last\)|Uncaught\b|Unhandled\b|[\w.$]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:|at\s+\S)/;

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The declared tests a run reports as failing: lines that start `FAIL:` followed by the exact
 * declared name. A `FAIL:` line naming anything else, or an uncaught error or traceback
 * outside a `FAIL:` line, counts as unattributed. A name that only appears in passing or
 * verbose lines is not failing.
 */
export function failingTests(
  output: string,
  declared: readonly string[],
): { names: string[]; unattributed: number } {
  const names = new Set<string>();
  let unattributed = 0;
  for (const line of output.split("\n")) {
    const match = /^\s*FAIL:\s*(.*)$/i.exec(line);
    if (!match) {
      // An uncaught error or trace outside a FAIL line is a failure no test name explains.
      if (UNCAUGHT.test(line)) unattributed += 1;
      continue;
    }
    const rest = squash(match[1] ?? "");
    const found = declared
      .filter((name) => {
        const key = squash(name);
        return rest === key || rest.startsWith(`${key}:`) || rest.startsWith(`${key} `);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (found) names.add(found);
    else unattributed += 1;
  }
  return { names: [...names], unattributed };
}

/** Every failing test of the run is attributed and in `covered`. */
export function allFailuresIn(
  output: string,
  declared: readonly string[],
  covered: readonly string[],
): boolean {
  const failing = failingTests(output, declared);
  return (
    failing.unattributed === 0 &&
    failing.names.length > 0 &&
    failing.names.every((name) => covered.includes(name))
  );
}

const recordView = z
  .object({
    file: z.string().optional(),
    tests: z.array(z.object({ name: z.string() }).passthrough()).optional(),
    disputes: z.array(disputeSchema).optional(),
  })
  .passthrough();
const attemptView = z
  .object({
    attempts: z.array(
      z
        .object({
          id: z.string(),
          status: z.string(),
          evidenceDigest: z.string().optional(),
          execution: z.object({ provenance: z.string() }).passthrough().optional(),
          disputes: z.array(z.string()).optional(),
          disputeRulings: z
            .array(z.object({ test: z.string(), ruling: z.string() }).passthrough())
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Where a critic selection keeps its state; mirrors `criticSelection`. */
function criticStatePath(workspace: WorkspaceState, feature: string, task?: string): string {
  return join(
    workspace.paths.featureDir(feature),
    `critic/${hashValue({ root: workspace.paths.root, task }).slice(0, 24)}.json`,
  );
}

/**
 * An upheld ruling counts only when the critic state holds the review attempt it names: an
 * accepted review VISP itself launched (adapter-observed), that carried this dispute and
 * ruled it upheld on the same evidence. Editing the acceptance record alone waives nothing.
 */
async function verifiedUpheld(
  workspace: WorkspaceState,
  feature: string,
  dispute: PinnedDispute,
): Promise<boolean> {
  const ruling = dispute.ruling;
  if (dispute.status !== "upheld" || ruling?.ruling !== "upheld") return false;
  const text = await workspace.files.readTextIfExists(
    criticStatePath(workspace, feature, ruling.task),
  );
  if (!text.ok || !text.value) return false;
  try {
    const state = attemptView.parse(JSON.parse(text.value));
    const attempt = state.attempts.find((entry) => entry.id === ruling.attempt);
    return (
      attempt?.status === "reviewed" &&
      attempt.execution?.provenance === "adapter-observed" &&
      attempt.evidenceDigest === ruling.evidence &&
      attempt.disputes?.includes(dispute.test) === true &&
      attempt.disputeRulings?.some(
        (entry) => entry.test === dispute.test && entry.ruling === "upheld",
      ) === true
    );
  } catch {
    return false;
  }
}

export interface Waivers {
  /** Waived declared tests whose rulings verify against the critic state. */
  readonly names: string[];
  readonly declared: string[];
  /** Whether the suite reads `VISP_WAIVED_TESTS`, so it can skip a test itself. */
  readonly suiteSkips: boolean;
}

export async function pinnedWaivers(workspace: WorkspaceState, feature: string): Promise<Waivers> {
  const none: Waivers = { names: [], declared: [], suiteSkips: false };
  const text = await workspace.files.readTextIfExists(
    workspace.paths.featureFile(feature, TESTS_RECORD),
  );
  if (!text.ok || !text.value) return none;
  try {
    const record = recordView.parse(JSON.parse(text.value));
    const upheld = (record.disputes ?? []).filter((entry) => entry.status === "upheld");
    const names: string[] = [];
    for (const entry of upheld)
      if (await verifiedUpheld(workspace, feature, entry)) names.push(entry.test);
    const source = record.file
      ? await workspace.files.readTextIfExists(join(workspace.paths.root, record.file))
      : undefined;
    return {
      names,
      declared: (record.tests ?? []).map((entry) => entry.name),
      suiteSkips: source?.ok === true && (source.value ?? "").includes(WAIVED_TESTS_ENV),
    };
  } catch {
    return none;
  }
}

/** Environment for a run of the pinned suite: the waived tests it must skip. */
export async function waivedTestsEnv(
  workspace: WorkspaceState,
  feature: string,
): Promise<Record<string, string>> {
  const { names } = await pinnedWaivers(workspace, feature);
  return names.length ? { [WAIVED_TESTS_ENV]: JSON.stringify(names) } : {};
}

/**
 * A suite that cannot skip tests still fails on a waived one. When every failing test it
 * names is waived, the failure is the waived tests' and the check counts as passed.
 */
export function waivedFailure(output: string, waivers: Waivers): boolean {
  return (
    !waivers.suiteSkips &&
    waivers.names.length > 0 &&
    allFailuresIn(output, waivers.declared, waivers.names)
  );
}

/** Whether a VISP-launched reviewer exists to rule; only then can a dispute be decided. */
export function reviewerRules(workspace: WorkspaceState): boolean {
  return workspace.config.critic?.launch === "codex-exec";
}

/** One line for a reply that reports a failing pinned test as a blocking check. */
export function disputeHint(workspace: WorkspaceState, command: "done" | "accept"): string {
  return reviewerRules(workspace)
    ? `If a failing pinned test contradicts the request, do not edit it or bend the product: visp ${command} --dispute "<test name>" --reason "<quote the request sentence + why>". The independent reviewer rules; upheld tests are waived.`
    : "No independent reviewer runs here, so a pinned test cannot be waived. Satisfy it; if it contradicts the request, keep the product as the request says and tell the user which request sentence and test disagree.";
}
