import { z } from "zod";
import { vispError } from "../../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
} from "../../core/file-transaction.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { withProductMutation } from "./runtime.js";

/**
 * Rules a user stated for all later work, captured from their recorded prompts. Weak workers
 * never looked for such rules in a later session, even when VISP's records held them; stated
 * in the request, the same workers applied them. So VISP captures them without the worker's
 * help and puts them in every later feature's request and work context.
 */
export const PROJECT_RULES_FILE = "rules.json";

const MAX_RULES_PER_PROMPT = 20;
const MAX_RULE_LENGTH = 600;
/** Phrases that say a statement outlives the request it came with. */
const LASTING =
  /\b(from now on|going forward|from here on|(all|any|every) (later|future|subsequent)\b)/i;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;

const projectRuleSchema = z
  .object({
    id: z.string().regex(/^R\d{3,}$/),
    text: z.string().min(1),
    feature: z.string(),
    capturedAt: z.string(),
  })
  .strict();
const projectRulesSchema = z
  .object({ version: z.literal(1), rules: z.array(projectRuleSchema) })
  .strict();
export type ProjectRule = z.infer<typeof projectRuleSchema>;

/** The rules a prompt states for later work: the list that follows such a statement, or the sentence itself. */
export function standingRules(prompt: string): string[] {
  const blocks = prompt.split(/\n\s*\n/);
  const rules: string[] = [];
  blocks.forEach((block, index) => {
    if (!LASTING.test(block)) return;
    const own = listItems(block);
    const listed = own.length ? own : followingList(blocks.slice(index + 1));
    rules.push(...(listed.length ? listed : lastingSentences(block)));
  });
  return rules.slice(0, MAX_RULES_PER_PROMPT).map((rule) => rule.slice(0, MAX_RULE_LENGTH));
}

function listItems(block: string): string[] {
  const items: string[] = [];
  let inItem = false;
  for (const line of block.split("\n")) {
    const item = LIST_ITEM.exec(line);
    if (item?.[1]) {
      items.push(item[1]);
      inItem = true;
    } else if (inItem && /^\s+\S/.test(line)) {
      items[items.length - 1] += ` ${line.trim()}`;
    } else {
      inItem = false;
    }
  }
  return items;
}

/** List blocks right after the statement; a one-line heading ending in ":" may come first. */
function followingList(blocks: readonly string[]): string[] {
  const collected: string[] = [];
  for (const block of blocks) {
    const items = listItems(block);
    if (items.length) collected.push(...items);
    else if (collected.length === 0 && /^[^\n]*:\s*$/.test(block.trim())) continue;
    else break;
  }
  return collected;
}

function lastingSentences(block: string): string[] {
  if (block.length > 400) return [];
  return block
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => LASTING.test(sentence));
}

export async function readProjectRules(
  workspace: WorkspaceState,
): Promise<Result<{ rules: ProjectRule[]; before: string | undefined }>> {
  const text = await workspace.files.readTextIfExists(
    workspace.paths.stateFile(PROJECT_RULES_FILE),
  );
  if (!text.ok) return text;
  if (text.value === undefined) return ok({ rules: [], before: undefined });
  let input: unknown;
  try {
    input = JSON.parse(text.value);
  } catch {
    return err(vispError("ARTIFACT_INVALID", "Invalid project rules"));
  }
  const parsed = projectRulesSchema.safeParse(input);
  if (!parsed.success) return err(vispError("ARTIFACT_INVALID", "Invalid project rules"));
  return ok({ rules: parsed.data.rules, before: text.value });
}

/** Adds rules not already recorded, numbered after the existing ones. */
export function mergeProjectRules(
  existing: readonly ProjectRule[],
  texts: readonly string[],
  feature: string,
  capturedAt: string,
): { rules: ProjectRule[]; added: ProjectRule[] } {
  const seen = new Set(existing.map((rule) => comparable(rule.text)));
  let next = existing.reduce((max, rule) => Math.max(max, Number(rule.id.slice(1))), 0);
  const added: ProjectRule[] = [];
  for (const text of texts) {
    const key = comparable(text);
    if (seen.has(key)) continue;
    seen.add(key);
    next += 1;
    added.push({ id: `R${String(next).padStart(3, "0")}`, text: text.trim(), feature, capturedAt });
  }
  return { rules: [...existing, ...added], added };
}

export function projectRulesMutation(
  workspace: WorkspaceState,
  before: string | undefined,
  rules: readonly ProjectRule[],
): FileMutation {
  return {
    kind: "write",
    path: workspace.paths.stateFile(PROJECT_RULES_FILE),
    content: `${JSON.stringify({ version: 1, rules }, null, 2)}\n`,
    expectedBefore: filePrecondition(before),
  };
}

/** A captured rule the user did not mean would otherwise join every later request. */
export function removeProjectRule(
  workspace: WorkspaceState,
  id: string,
): Promise<Result<ProjectRule>> {
  return withProductMutation(workspace, async () => {
    const recorded = await readProjectRules(workspace);
    if (!recorded.ok) return recorded;
    const rule = recorded.value.rules.find((entry) => entry.id === id);
    if (!rule)
      return err(
        vispError("ARTIFACT_INVALID", `No project rule ${id}`, { recovery: "visp rules" }),
      );
    const rules = recorded.value.rules.filter((entry) => entry.id !== id);
    const saved = await applyFileTransaction(workspace.paths.root, "remove-project-rule", [
      projectRulesMutation(workspace, recorded.value.before, rules),
    ]);
    return saved.ok ? ok(rule) : saved;
  });
}

/** Plain numbered lines: workers follow plain text where they skim escaped JSON. */
export function projectRulesText(rules: readonly Pick<ProjectRule, "id" | "text">[]): string {
  if (rules.length === 0) return "";
  return [
    "Project rules the user stated for all later work on this project (they apply here too):",
    ...rules.map((rule) => `${rule.id} ${rule.text}`),
  ].join("\n");
}

function comparable(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
