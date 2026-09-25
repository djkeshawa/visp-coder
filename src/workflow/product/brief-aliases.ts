import { acceptanceBaselineSchema } from "../artifacts/acceptance.js";
import type { ProductBrief } from "./model.js";

/**
 * Authored briefs from real runs were rejected for shapes whose meaning is unambiguous:
 * `description` for `statement`, `then` for `expected`, a string where a list belongs,
 * `decision`/`reason`, or slice IDs such as `S1`. Rewriting them before strict validation
 * saves a model a failed round trip. Every rewrite is reported; anything ambiguous is left
 * for the parser to reject.
 */
export interface NormalizedBriefInput {
  readonly value: unknown;
  readonly normalized: string[];
}

type Entry = Record<string, unknown>;
type Mode = "brief" | "patch";

const OUTCOME_KINDS: Record<string, string> = {
  behavior: "functional",
  behaviour: "functional",
  feature: "functional",
  "non-functional": "quality",
  nonfunctional: "quality",
  performance: "quality",
  security: "quality",
  reliability: "quality",
  maintainability: "quality",
  documentation: "quality",
  docs: "quality",
  accessibility: "quality",
  compatibility: "quality",
  usability: "experience",
  ux: "experience",
  visual: "experience",
  design: "experience",
  aesthetic: "experience",
};
const VISP_OWNED = ["version", "feature", "originalRequest"] as const;
const LIST_FIELDS = ["outcomes", "examples", "decisions", "checks", "slices"] as const;
const TASK_ID = /^T\d{3,}$/;

export function normalizeBriefInput(
  input: unknown,
  mode: Mode,
  previous: ProductBrief,
): NormalizedBriefInput {
  if (!isEntry(input)) return { value: input, normalized: [] };
  const notes: string[] = [];
  // Authored input is plain YAML/JSON data; a copy keeps the caller's object untouched.
  const brief: Entry = structuredClone(input);
  // A model resubmitting a VISP reply may echo the report of an earlier normalization.
  delete brief.normalized;
  normalizeOwnedFields(brief, mode, previous, notes);
  for (const key of LIST_FIELDS)
    if (brief[key] !== undefined && !Array.isArray(brief[key])) brief[key] = [brief[key]];
  const existing = existingIds(previous);
  const outcomes = entries(brief.outcomes);
  for (const [index, entry] of outcomes.entries())
    normalizeOutcome(entry, `outcomes[${index}]`, isNew(entry, existing.outcomes, mode), notes);
  for (const [index, entry] of entries(brief.examples).entries())
    normalizeExample(entry, `examples[${index}]`, isNew(entry, existing.examples, mode), notes);
  for (const [index, entry] of entries(brief.decisions).entries())
    normalizeDecision(entry, `decisions[${index}]`, notes);
  for (const [index, entry] of entries(brief.checks).entries())
    normalizeCheck(entry, `checks[${index}]`, notes);
  normalizeSlices(entries(brief.slices), existing.slices, notes);
  liftInlineChecks(brief, entries(brief.slices), notes);
  toList(brief, "uncertainties", "uncertainties", notes);
  if (mode === "brief") normalizeAcceptanceBaseline(brief, outcomes, previous, notes);
  return { value: brief, normalized: notes };
}

function normalizeOwnedFields(brief: Entry, mode: Mode, previous: ProductBrief, notes: string[]) {
  // Workers resubmitting a full brief often reworded the request and were refused. VISP
  // records the request verbatim; a submitted variant is ignored and reported.
  if (brief.originalRequest !== undefined && brief.originalRequest !== previous.originalRequest) {
    brief.originalRequest = previous.originalRequest;
    notes.push("originalRequest: VISP keeps the recorded request; the submitted text was ignored");
  }
  for (const key of VISP_OWNED) {
    if (mode === "patch") {
      // Patches leave these to VISP; an unchanged copy is harmless, a change stays an error.
      if (brief[key] === previous[key]) delete brief[key];
    } else if (brief[key] === undefined) {
      brief[key] = previous[key];
      notes.push(`${key}: kept VISP's recorded value`);
    }
  }
  // A patch naming the protected acceptance baseline stays refused by the patch parser.
}

function normalizeOutcome(entry: Entry, path: string, isNewEntry: boolean, notes: string[]) {
  rename(entry, ["description", "text"], "statement", path, notes);
  if (typeof entry.kind === "string") {
    const kind = OUTCOME_KINDS[entry.kind.trim().toLowerCase()];
    if (kind) {
      notes.push(`${path}.kind: ${entry.kind} → ${kind}`);
      entry.kind = kind;
    }
  } else if (entry.kind === undefined && isNewEntry) {
    entry.kind = "functional";
    notes.push(`${path}.kind: missing → functional`);
  }
  for (const [index, expectation] of entries(entry.expectations).entries())
    rename(
      expectation,
      ["description", "text"],
      "statement",
      `${path}.expectations[${index}]`,
      notes,
    );
}

function normalizeExample(entry: Entry, path: string, isNewEntry: boolean, notes: string[]) {
  rename(entry, ["then", "expect"], "expected", path, notes);
  rename(entry, ["outcome"], "outcomes", path, notes);
  rename(entry, ["name", "scenario"], "title", path, notes);
  for (const key of ["given", "expected", "outcomes"]) toList(entry, key, `${path}.${key}`, notes);
  if (Array.isArray(entry.when) && entry.when.every((step) => typeof step === "string")) {
    entry.when = entry.when.join("; ");
    notes.push(`${path}.when: list joined into one action`);
  }
  if (entry.title === undefined && isNewEntry && typeof entry.when === "string" && entry.when) {
    entry.title = entry.when.length > 80 ? `${entry.when.slice(0, 79)}…` : entry.when;
    notes.push(`${path}.title: missing → taken from when`);
  }
}

function normalizeDecision(entry: Entry, path: string, notes: string[]) {
  rename(entry, ["decision", "description"], "statement", path, notes);
  rename(entry, ["reason", "why"], "rationale", path, notes);
  rename(entry, ["outcome"], "outcomes", path, notes);
  for (const key of ["evidence", "implications", "outcomes"])
    toList(entry, key, `${path}.${key}`, notes);
}

function normalizeCheck(entry: Entry, path: string, notes: string[]) {
  rename(entry, ["outcome", "verifies", "covers"], "outcomes", path, notes);
  if (entry.command === undefined && isEntry(entry.journey)) {
    entry.command = { kind: "browser-journey", journey: entry.journey };
    delete entry.journey;
    notes.push(`${path}.journey → command.journey`);
  }
  for (const key of ["kind", "description", "name", "title"])
    if (typeof entry[key] === "string" && entry.command !== undefined) {
      delete entry[key];
      notes.push(`${path}.${key}: ignored; checks are defined by command`);
    }
  for (const key of ["outcomes", "files"]) toList(entry, key, `${path}.${key}`, notes);
}

function normalizeSlices(slices: Entry[], existing: ReadonlySet<string>, notes: string[]) {
  const renamed = renameSliceIds(slices, existing, notes);
  slices.forEach((entry, index) => {
    const path = `slices[${index}]`;
    rename(entry, ["title", "name", "description", "statement"], "goal", path, notes);
    rename(entry, ["description", "statement"], "approach", path, notes);
    for (const key of ["title", "name"])
      if (typeof entry[key] === "string") {
        delete entry[key];
        notes.push(`${path}.${key}: ignored; goal already states the slice`);
      }
    normalizeScope(entry, path, notes);
    for (const key of ["outcomes", "checks", "dependsOn"])
      toList(entry, key, `${path}.${key}`, notes);
    if (Array.isArray(entry.dependsOn))
      entry.dependsOn = entry.dependsOn.map((id) =>
        typeof id === "string" ? (renamed.get(id) ?? id) : id,
      );
  });
}

/** A check written inside `slices[].checks` becomes a brief check the slice references. */
function liftInlineChecks(brief: Entry, slices: Entry[], notes: string[]) {
  const checks = Array.isArray(brief.checks) ? brief.checks : [];
  const used = new Set(
    entries(checks).flatMap((check) => (typeof check.id === "string" ? [check.id] : [])),
  );
  for (const [index, slice] of slices.entries()) {
    if (!Array.isArray(slice.checks)) continue;
    slice.checks = slice.checks.map((entry, position) => {
      if (!isEntry(entry)) return entry;
      let id = typeof entry.id === "string" ? entry.id : undefined;
      for (let ordinal = 1; !id || (used.has(id) && entry.id === undefined); ordinal++)
        id = `${String(slice.id)}-C${ordinal}`;
      used.add(id);
      const check: Entry = { ...entry, id };
      normalizeCheck(check, `slices[${index}].checks[${position}]`, notes);
      checks.push(check);
      notes.push(`slices[${index}].checks[${position}] → checks ${id}`);
      return id;
    });
  }
  if (checks.length) brief.checks = checks;
}

/** Only slice IDs have a fixed format; references to a renamed slice follow it. */
function renameSliceIds(
  slices: Entry[],
  existing: ReadonlySet<string>,
  notes: string[],
): Map<string, string> {
  const renamed = new Map<string, string>();
  const used = new Set([
    ...existing,
    ...slices.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : [])),
  ]);
  let ordinal = 1;
  slices.forEach((entry, index) => {
    if (typeof entry.id !== "string" || TASK_ID.test(entry.id)) return;
    const digits = /^t(\d+)$/i.exec(entry.id)?.[1];
    let id = digits ? `T${digits.padStart(3, "0")}` : undefined;
    if (!id || (used.has(id) && !existing.has(id))) {
      while (used.has(`T${String(ordinal).padStart(3, "0")}`)) ordinal++;
      id = `T${String(ordinal).padStart(3, "0")}`;
    }
    used.add(id);
    renamed.set(entry.id, id);
    notes.push(`slices[${index}].id: ${entry.id} → ${id}`);
    entry.id = id;
  });
  return renamed;
}

function normalizeScope(entry: Entry, path: string, notes: string[]) {
  if (typeof entry.scope === "string" || Array.isArray(entry.scope)) {
    entry.scope = { allowed: Array.isArray(entry.scope) ? entry.scope : [entry.scope] };
    notes.push(`${path}.scope: list → scope.allowed`);
  }
  if (!isEntry(entry.scope)) return;
  rename(entry.scope, ["excluded", "exclude", "blocked"], "forbidden", `${path}.scope`, notes);
  for (const key of ["allowed", "expected", "forbidden"])
    toList(entry.scope, key, `${path}.scope.${key}`, notes);
}

/**
 * VISP captures the acceptance baseline (pinned verifier files with hashes); authors
 * cannot write valid entries by hand. Models put acceptance criteria there instead, so
 * criteria naming an outcome become that outcome's expectations and the rest are reported.
 */
function normalizeAcceptanceBaseline(
  brief: Entry,
  outcomes: Entry[],
  previous: ProductBrief,
  notes: string[],
) {
  const supplied = brief.acceptanceBaseline;
  if (supplied !== undefined && acceptanceBaselineSchema.safeParse(supplied).success) return;
  brief.acceptanceBaseline = previous.acceptanceBaseline;
  if (supplied === undefined) {
    notes.push("acceptanceBaseline: kept VISP's recorded value");
    return;
  }
  for (const criterion of Array.isArray(supplied) ? supplied : [supplied]) {
    const text = criterionText(criterion);
    const outcome = isEntry(criterion) ? criterion.outcome : undefined;
    const target = outcomes.find((entry) => typeof outcome === "string" && entry.id === outcome);
    if (target && text) {
      target.expectations = [...entries(target.expectations), { statement: text }];
      notes.push(`acceptanceBaseline: "${short(text)}" → ${outcome} expectation`);
    } else
      notes.push(
        `acceptanceBaseline: VISP records this; "${short(text ?? JSON.stringify(criterion))}" was not saved. Add acceptance criteria as outcomes[].expectations`,
      );
  }
}

function criterionText(criterion: unknown): string | undefined {
  if (typeof criterion === "string") return criterion;
  if (!isEntry(criterion)) return undefined;
  for (const key of ["expectation", "statement", "description"])
    if (typeof criterion[key] === "string") return criterion[key];
  return undefined;
}

function rename(entry: Entry, aliases: string[], target: string, path: string, notes: string[]) {
  for (const alias of aliases) {
    if (entry[alias] === undefined || entry[target] !== undefined) continue;
    entry[target] = entry[alias];
    delete entry[alias];
    notes.push(`${path}.${alias} → ${target}`);
  }
}

function toList(entry: Entry, key: string, path: string, notes: string[]) {
  if (typeof entry[key] !== "string") return;
  entry[key] = [entry[key]];
  notes.push(`${path}: text → list`);
}

function existingIds(previous: ProductBrief) {
  return {
    outcomes: new Set(previous.outcomes.map((entry) => entry.id)),
    examples: new Set(previous.examples.map((entry) => entry.id)),
    slices: new Set(previous.slices.map((entry) => entry.id)),
  };
}

/** A full brief states every entry; a patch entry with a known ID changes only named fields. */
function isNew(entry: Entry, existing: ReadonlySet<string>, mode: Mode): boolean {
  return mode === "brief" || typeof entry.id !== "string" || !existing.has(entry.id);
}

function entries(list: unknown): Entry[] {
  return Array.isArray(list) ? list.filter(isEntry) : [];
}

function isEntry(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function short(text: string): string {
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}
