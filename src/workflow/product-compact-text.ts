/** Where the reader runs: MCP tool text, or CLI text output read by a model through a shell. */
export type ReplyChannel = "mcp" | "cli";

const WORDING = {
  mcp: {
    full: "Read structuredContent.data for complete context.",
    detail: "Full result: detail:true.",
    readBrief: (feature: string) => `visp_brief {feature:"${feature}"}`,
    template: (feature: string) =>
      `visp_work {feature:"${feature}", check:"<command that runs your tests>"} works the whole request as one slice. Only for several independently usable parts, plan slices: visp_brief {feature:"${feature}", template:true}`,
    next: (feature: string) => `visp_next {feature:"${feature}"}`,
  },
  cli: {
    full: "Full result: add --json.",
    detail: "Full result: add --json.",
    readBrief: (feature: string) => `visp brief --feature ${feature}`,
    template: (feature: string) =>
      `visp work --feature ${feature} --check "<command that runs your tests>" works the whole request as one slice. Only for several independently usable parts, plan slices: visp brief --template --feature ${feature}`,
    next: (feature: string) => `visp next --feature ${feature}`,
  },
} as const;

const COMPACT: Record<string, (name: string, value: unknown, channel: ReplyChannel) => string> = {
  work: compactProductText,
  review: compactProductText,
  capture: compactProductText,
  control: compactProductText,
  verify: compactVerificationText,
  done: compactVerificationText,
  accept: compactVerificationText,
  feature: compactBriefText,
  brief: compactBriefText,
  next: compactNextText,
};

/** The compact text for an operation (`done` or `visp_done`), or undefined when it has none. */
export function compactProductReply(
  operation: string,
  value: unknown,
  channel: ReplyChannel,
): string | undefined {
  const render = COMPACT[operation.replace(/^visp_/, "")];
  return render ? render(operation, value, channel) : undefined;
}

const SCALAR_FIELDS = [
  "feature",
  "task",
  "taskClass",
  "objective",
  "mayEdit",
  "status",
  "detected",
  "failure",
  "recorded",
  "session",
  "packetPath",
  "responsePath",
  "runId",
  "replayCommand",
  "command",
  "instructions",
  "approach",
] as const;
const LIST_FIELDS = [
  "outcomes",
  "examples",
  "decisions",
  "memory",
  "skills",
  "graph",
  "unresolved",
  "findings",
  "evidenceGaps",
  "journeyFailures",
  "imageGaps",
] as const;
const PLAN_FIELDS = ["capability", "firstSlice", "nextCheck", "findings", "gaps"] as const;
const FEEDBACK_FIELDS = [
  "independentTests",
  "criticUnderstanding",
  "criticAdvice",
  "userFeedback",
  "journeyFeedback",
  "next",
] as const;

/** Essential decisions remain readable through hosts which forward only text blocks. */
export function compactProductText(
  name: string,
  value: unknown,
  channel: ReplyChannel = "mcp",
): string {
  const data = object(value);
  const summary: Record<string, unknown> = {};
  for (const key of SCALAR_FIELDS) if (data[key] !== undefined) summary[key] = data[key];
  // Scope is a permission boundary: never silently truncate its forbidden paths.
  if (data.scope !== undefined) summary.scope = data.scope;
  for (const key of LIST_FIELDS)
    if (Array.isArray(data[key]) && data[key].length) summary[key] = boundedRows(data[key]);
  if (Array.isArray(data.checks) && data.checks.length) summary.checks = checkRows(data.checks);
  const notes = workerNotes(data.notes);
  if (notes.length) summary.notes = boundedRows(notes);
  addPlanSummary(data, summary);
  for (const key of FEEDBACK_FIELDS) if (data[key] !== undefined) summary[key] = bounded(data[key]);
  addObservationSummary(data, summary);
  return `${name}: ${JSON.stringify(summary)}${detailCommand(name, data)}\n${WORDING[channel].full} Tool success does not imply product acceptance.`;
}

/** Graph extraction uncertainty is diagnostic detail, not guidance for the worker. */
function workerNotes(notes: unknown): unknown[] {
  return Array.isArray(notes)
    ? notes.filter((note) => typeof note !== "string" || !note.startsWith("Graph uncertainty:"))
    : [];
}

function addPlanSummary(data: Record<string, unknown>, summary: Record<string, unknown>) {
  const plan = object(data.feedbackPlan ?? data.feedback);
  for (const key of PLAN_FIELDS) if (plan[key] !== undefined) summary[key] = bounded(plan[key]);
  if (plan.observationPlan !== undefined && usesBrowser(data))
    summary.observationPlan = bounded(plan.observationPlan);
}

/** A check's command is what the worker runs; bounding its argv would hide part of it. */
function checkRows(checks: unknown[]) {
  return {
    entries: checks.slice(0, 5).map((check) => {
      const entry = object(check);
      return { ...object(bounded(entry)), command: entry.command };
    }),
    remaining: Math.max(0, checks.length - 5),
  };
}

/** Browser observation guidance only helps work that drives a browser. */
function usesBrowser(data: Record<string, unknown>): boolean {
  const checks = Array.isArray(data.checks) ? data.checks : [];
  return (
    Array.isArray(data.captures) ||
    Array.isArray(data.images) ||
    checks.some((check) => object(object(check).command).kind === "browser-journey")
  );
}

function addObservationSummary(data: Record<string, unknown>, summary: Record<string, unknown>) {
  if (Array.isArray(data.captures))
    summary.captures = data.captures
      .map((capture) => {
        const { id, path } = object(capture);
        return { id, path };
      })
      .slice(0, 6);
  if (data.observationPlan && usesBrowser(data)) summary.observationPlan = data.observationPlan;
  if (data.reviewer) summary.reviewer = data.reviewer;
  if (data.images) summary.images = Array.isArray(data.images) ? data.images.length : undefined;
}

function detailCommand(name: string, data: Record<string, unknown>): string {
  if (!name.endsWith("work") || typeof data.feature !== "string") return "";
  return `\nRead-only details: visp work --inspect --feature ${data.feature}${typeof data.task === "string" ? ` --task ${data.task}` : ""}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedRows(rows: unknown[]) {
  return { entries: rows.slice(0, 5).map(bounded), remaining: Math.max(0, rows.length - 5) };
}

function bounded(value: unknown): unknown {
  if (typeof value === "string") return value.length > 800 ? `${value.slice(0, 800)}…` : value;
  if (Array.isArray(value)) return value.length > 5 ? boundedRows(value) : value.map(bounded);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !["data", "output", "steps", "sha256", "subjectDigest", "contractDigest"].includes(key),
      )
      .map(([key, entry]) => [key, bounded(entry)]),
  );
  if (typeof result.content === "string" && result.content !== object(value).content)
    result.truncated = true;
  return result;
}

/**
 * Slice checks and closure. A text-only model needs the verdict, each failing check's
 * output tail, what blocks closure and the next step; graph trace, digests and repeated
 * outcome statements stay in structured data.
 */
export function compactVerificationText(
  name: string,
  value: unknown,
  channel: ReplyChannel = "mcp",
): string {
  const data = object(value);
  const plan = object(data.feedbackPlan);
  const next = object(data.next);
  const unresolved = rows(data.outcomes)
    .filter((outcome) => outcome.satisfied !== true)
    .map((outcome) => `${outcome.id}: behavior ${outcome.behavior}; review ${outcome.review}`);
  const summary = {
    feature: data.feature,
    task: data.task,
    passed: data.passed,
    closed: data.closed,
    delivery: data.delivery,
    recovery: data.recovery,
    recommendation: data.recommendation,
    checks: rows(data.executions).map(executionSummary),
    unresolved,
    gaps: closureGaps(data.gaps, unresolved),
    findings:
      Array.isArray(plan.findings) && plan.findings.length ? bounded(plan.findings) : undefined,
    acceptanceTests: data.acceptanceTests ? bounded(data.acceptanceTests) : undefined,
    critic: data.critic ? bounded(data.critic) : undefined,
    nextProbe: plan.nextProbe ? bounded(object(plan.nextProbe).question) : undefined,
    next: data.next
      ? { action: next.action, objective: next.objective, command: next.command }
      : undefined,
  };
  return `${name}: ${JSON.stringify(summary)}\n${WORDING[channel].detail} Tool success does not imply product acceptance.`;
}

/** Gaps repeat outcome statuses first; the actionable environment or scope reason comes last. */
function closureGaps(gaps: unknown, unresolved: readonly string[]): unknown {
  if (!Array.isArray(gaps)) return undefined;
  const shown = new Set(unresolved);
  const distinct = [...new Set(gaps)].filter((gap) => !shown.has(gap as string));
  if (!distinct.length) return undefined;
  return {
    entries: distinct.slice(0, 12).map(bounded),
    remaining: Math.max(0, distinct.length - 12),
  };
}

function executionSummary(execution: Record<string, unknown>): unknown {
  if (execution.status === "passed") return `${execution.check}: passed`;
  const output = typeof execution.output === "string" ? execution.output : "";
  return {
    check: execution.check,
    status: execution.status,
    exitCode: execution.exitCode,
    output: output.length > 1_500 ? `…${output.slice(-1_500)}` : output,
  };
}

/** Feature creation and brief updates: the author already holds the content it wrote. */
export function compactBriefText(
  name: string,
  value: unknown,
  channel: ReplyChannel = "mcp",
): string {
  const data = object(value);
  const brief = data.brief === undefined ? data : object(data.brief);
  const summary = {
    feature: brief.feature,
    incomplete: brief.incomplete,
    outcomes: rows(brief.outcomes).map((entry) => `${entry.id} (${entry.kind})`),
    examples: rows(brief.examples).map((entry) => entry.id),
    checks: rows(brief.checks).map((entry) => entry.id),
    slices: rows(brief.slices).map((entry) => ({
      id: entry.id,
      goal: entry.goal,
      scope: object(entry.scope).allowed,
      checks: entry.checks,
    })),
    normalized: data.normalized,
    branchCreated: data.branchCreated,
    branchWarning: data.branchWarning,
  };
  // The adapter does not choose the next slice; visp_next owns that decision.
  const wording = WORDING[channel];
  const feature = String(brief.feature);
  const next = name.endsWith("feature") ? wording.template(feature) : wording.next(feature);
  return `${name}: ${JSON.stringify(summary)}\nNext: ${next}\nRead the full brief with ${wording.readBrief(feature)}.`;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

/**
 * The next step. Critic findings arrive both as evidence lines and as criticAdvice
 * findings; the worker needs each once, with the action and command.
 */
export function compactNextText(
  name: string,
  value: unknown,
  channel: ReplyChannel = "mcp",
): string {
  const data = object(value);
  const advice = object(data.criticAdvice);
  const evidence = Array.isArray(data.evidence) ? [...new Set(data.evidence)] : [];
  const summary = {
    feature: data.feature,
    task: data.task,
    action: data.action,
    objective: data.objective,
    command: data.command,
    mayEdit: data.mayEdit,
    completion: data.completion,
    recovery: data.recovery,
    evidence: evidence.length
      ? { entries: evidence.slice(0, 8).map(bounded), remaining: Math.max(0, evidence.length - 8) }
      : undefined,
    critic: data.criticAdvice
      ? { status: advice.status, command: advice.command, guidance: bounded(advice.guidance) }
      : undefined,
    userFeedback: data.userFeedback ? bounded(data.userFeedback) : undefined,
  };
  return `${name}: ${JSON.stringify(summary)}\n${WORDING[channel].detail}`;
}
