/** Historical test-fixture builder; never used by the product workflow. */
import { describeCommand } from "../../../../src/core/exec.js";
import { ok, type Result } from "../../../../src/core/result.js";
import type { ContextContract, ContextPack } from "../../../../src/workflow/artifacts/context.js";
import { type Task, validationChecksFor } from "../../../../src/workflow/artifacts/tasks.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { legacyStore } from "../legacy-store.js";

export async function readContextContract(
  state: WorkspaceState,
  feature: string,
  task: Task,
): Promise<Result<ContextContract>> {
  const [intent, spec, plan] = await Promise.all([
    state.store.readIntent(feature),
    state.store.readSpecIfExists(feature),
    legacyStore(state).readPlanIfExists(feature),
  ]);
  if (!intent.ok) return intent;
  if (!spec.ok) return spec;
  if (!plan.ok) return plan;

  return ok({
    schemaVersion: 1,
    featureGoal: intent.value.goal,
    sourceBrief: intent.value.sourceBrief ?? intent.value.goal,
    description: task.description,
    allowedFiles: [...task.allowedFiles],
    forbiddenFiles: [...task.forbiddenFiles],
    expectedFiles: [...task.expectedFiles],
    validationCommands: [
      ...new Set(
        [
          ...validationChecksFor(task).map((check) => check.command),
          ...state.config.workflow.validationCommands,
        ].map(describeCommand),
      ),
    ],
    doneCriteria: [...task.doneCriteria],
    requirements:
      spec.value?.requirements.filter((entry) => task.requirements.includes(entry.id)) ?? [],
    qualityRequirements:
      spec.value?.qualityRequirements.filter((entry) =>
        task.qualityRequirements.includes(entry.id),
      ) ?? [],
    scenarios:
      spec.value?.behaviorScenarios.filter((entry) => task.scenarios.includes(entry.id)) ?? [],
    decisions: plan.value?.decisions.map((entry) => `${entry.statement}: ${entry.rationale}`) ?? [],
    invariants: plan.value?.invariants ?? [],
    openQuestions: spec.value?.openQuestions ?? [],
    ...(spec.value?.designBrief ? { designBrief: spec.value.designBrief } : {}),
  });
}

/** Stable authored instructions precede changing repository and retry observations. */
export function renderContextContract(pack: ContextPack): string[] {
  const contract = pack.contract;
  if (!contract) return [];
  const lines = ["", "source brief (verbatim):", contract.sourceBrief];
  if (contract.description) lines.push("", "task detail:", contract.description);
  for (const requirement of [...contract.requirements, ...contract.qualityRequirements]) {
    lines.push("", `${requirement.id} (${requirement.priority}): ${requirement.statement}`);
    if ("target" in requirement) lines.push(`target: ${requirement.target}`);
    for (const criterion of requirement.criteria) {
      lines.push(`  ${criterion.id}: ${criterion.statement}`);
      if (criterion.verification) lines.push(`  verify: ${criterion.verification}`);
    }
  }
  for (const scenario of contract.scenarios) {
    lines.push(
      "",
      `${scenario.id}: ${scenario.title}`,
      `  given: ${scenario.given.join("; ")}`,
      `  when: ${scenario.when}`,
      `  expect: ${scenario.expected.join("; ")}`,
    );
  }
  lines.push(...journeyGuidance(contract.scenarios.length));
  for (const [title, entries] of [
    ["design decisions", contract.decisions],
    ["invariants", contract.invariants],
    ["unresolved questions, do not assume", contract.openQuestions],
  ] as const) {
    if (entries.length) lines.push("", `${title}:`, ...entries.map((entry) => `  - ${entry}`));
  }
  if (contract.designBrief) {
    lines.push(
      "",
      "design brief:",
      JSON.stringify(contract.designBrief),
      "Compare against this brief and its references. Keep subjective aesthetic judgments separate from functional and accessibility checks.",
      "Use at most two critique/revision cycles within the remaining task budget; unresolved subjective disagreements require human adjudication.",
    );
  }
  return lines;
}

function journeyGuidance(scenarioCount: number): string[] {
  return scenarioCount > 0 ? ["", JOURNEY_GUIDANCE] : [];
}

/** Historical domain-neutral prompt attached to workflow scenarios. */
const JOURNEY_GUIDANCE =
  "Start a representative journey from an ordinary fresh state and reach its outcome through production controls. Do not assume the outcome in Given or force it through test-only state changes. For repeatable operations, exercise the next operation after completion, then failure, recovery, and another operation. Activate restart, retry, or repeat controls and verify their resulting state; their presence or label is insufficient. Assert the visible or persisted downstream result, not just input acceptance or an internal counter. Include a negative case where the causal action is absent or ineffective and verify that the successful outcome does not occur. Define which state resets and which state persists.";
