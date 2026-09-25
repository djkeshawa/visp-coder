/** Historical test-fixture builder; never used by the product workflow. */
import { BLOCK, PRODUCT_NAME } from "../../../../src/core/constants.js";
import { ok, type Result } from "../../../../src/core/result.js";
import type { ContextPack } from "../../../../src/workflow/artifacts/context.js";
import type { Task } from "../../../../src/workflow/artifacts/tasks.js";
import { requireImplementationFoundation } from "../../../../src/workflow/gates/readiness.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { renderContextContract } from "./contract.js";
import { describeRanges, PRINTED_OMISSIONS, renderAttemptFeedback } from "./render.js";

/**
 * The block handed to a coding agent when it starts a task. It states the goal,
 * the exact files it may write, and what will be checked, so the agent is not
 * guessing at boundaries it will later be refused for crossing.
 */

export interface HandoffInput {
  readonly feature: string;
  readonly goal: string;
  readonly task: Task;
  readonly pack?: ContextPack;
  readonly validationCommands: readonly string[];
}

export async function buildHandoff(
  state: WorkspaceState,
  input: Omit<HandoffInput, "goal" | "pack">,
): Promise<Result<string>> {
  const foundation = await requireImplementationFoundation(
    state,
    `${PRODUCT_NAME} handoff --task ${input.task.id}`,
  );
  if (!foundation.ok) return foundation;

  const [intent, pack] = await Promise.all([
    state.store.readIntent(input.feature),
    state.store.readContextPack(input.feature, input.task.id),
  ]);
  if (!intent.ok) return intent;
  if (!pack.ok) return pack;
  return ok(
    renderHandoff({
      ...input,
      goal: intent.value.goal,
      ...(pack.value ? { pack: pack.value } : {}),
    }),
  );
}

export function renderHandoff(input: HandoffInput): string {
  const { task } = input;

  const sections: string[] = [
    `feature: ${input.feature}`,
    `task: ${task.id}  ${task.title}`,
    `goal: ${input.goal}`,
    ...(input.pack ? renderContextContract(input.pack) : []),
    "",
    "you may write:",
    ...bullets(task.allowedFiles),
  ];

  if (task.forbiddenFiles.length > 0) {
    sections.push("", "you may never write:", ...bullets(task.forbiddenFiles));
  }

  if (task.expectedFiles.length > 0) {
    sections.push("", "a complete change should touch:", ...bullets(task.expectedFiles));
  }

  sections.push(...renderHandoffContext(input.pack));

  if (input.validationCommands.length > 0) {
    sections.push("", "this will be checked by:", ...bullets(input.validationCommands));
  }

  if (task.doneCriteria.length > 0) {
    sections.push("", "done when:", ...bullets(task.doneCriteria));
  }

  sections.push(
    "",
    "rules:",
    "  - Scope checks reject changed files outside the allowed list; preventive controls depend on the configured host.",
    "  - To widen scope, change the task, not the attempt.",
    `  - When the change is made, run: ${PRODUCT_NAME} done`,
    `  - Before a final answer, run: ${PRODUCT_NAME} next`,
    "  - Do not claim this task is complete until done closes it; report any remaining command as a blocker.",
  );

  return `BEGIN_${BLOCK.handoff}\n${sections.join("\n")}\nEND_${BLOCK.handoff}`;
}

function renderHandoffContext(pack: ContextPack | undefined): string[] {
  if (!pack) return [];
  const sections: string[] = [];
  const previewLimit = pack.omissionPreviewLimit ?? PRINTED_OMISSIONS;
  if (pack.files.length > 0) {
    sections.push(
      "",
      "read first:",
      ...bullets(
        pack.files.map(
          (file) => `${file.path}${describeRanges(file)}  (${file.reason}) sha256:${file.hash}`,
        ),
      ),
    );
  }

  // A briefing that hides what the budget dropped reads as complete when it
  // is not — the gap is stated, like every other gap.
  if (pack.omitted.length > 0) {
    sections.push(
      "",
      "left out, inspect the reason before assuming it exists:",
      ...bullets(
        pack.omitted
          .slice(0, previewLimit)
          .map((entry) => `${entry.path}  (${entry.reason}; ${entry.detail})`),
      ),
    );
    if (pack.omitted.length > previewLimit) {
      sections.push(
        `  ${pack.omitted.length} omissions total; full ledger: ${pack.artifactRef ?? "context artifact"}#/omitted`,
      );
    }
  }
  if (pack.budgetStatus === "essential-overflow") {
    sections.push(
      "",
      "Required context exceeds the token budget. Optional files were omitted; increase the budget or narrow the task contract before adding context.",
    );
  }

  if (pack.unknowns.length > 0) {
    sections.push("", "not known, do not assume:", ...bullets(pack.unknowns));
  }

  // The re-brief after a failed attempt must carry the failure it answers.
  sections.push(...renderAttemptFeedback(pack));
  return sections;
}

function bullets(values: readonly string[]): string[] {
  return values.map((value) => `  - ${value}`);
}
