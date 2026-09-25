import { ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { criticStatus } from "./critic-status.js";
import type { ProductNext } from "./status.js";

/** Criticism supplements baseline navigation; availability never becomes a product gate. */
export async function criticNext(
  workspace: WorkspaceState,
  next: ProductNext,
): Promise<Result<ProductNext>> {
  if (!next.feature) return ok(next);
  const status = await criticStatus(workspace, { feature: next.feature, task: next.task });
  if (!status.ok)
    return ok({
      ...next,
      criticAdvice: {
        status: "unavailable",
        guidance: `Critic status unavailable: ${status.error.message}. Continue the baseline build–observe–fix loop; report this review limitation.`,
      },
    });
  return ok(withCriticAdvice(next, status.value));
}

/** The command a caller should execute when the current product is reviewable. */
export function criticRouteCommand(next: ProductNext): string | undefined {
  return next.criticAdvice?.status === "suggested" ? next.criticAdvice.command : undefined;
}

type Status = Extract<Awaited<ReturnType<typeof criticStatus>>, { ok: true }>["value"];
function withCriticAdvice(next: ProductNext, critic: Status): ProductNext {
  if (!critic.enabled || !("next" in critic)) return next;
  if (critic.next === "normal-acceptance") return next;
  const environmentGap = next.completion === "unresolved-environment";
  const command = `visp critic --feature ${next.feature}${next.task ? ` --task ${next.task}` : ""}`;
  if (critic.stopped || critic.next === "worker")
    return { ...next, criticAdvice: retainedAdvice(critic) };
  if (critic.renderedEvidence.relevant && (environmentGap || !critic.renderedEvidence.recorded))
    return {
      ...next,
      criticAdvice: {
        status: "suggested",
        command: next.command,
        guidance:
          "Keep critic capacity for the rendered product. Recover the browser through the supported host path and observe a usable interaction before product critique. Continue scoped implementation meanwhile. Source-only advice is an explicit option for a concrete code question, not an automatic substitute for visual feedback; it spends the same call budget.",
      },
    };
  if (
    !environmentGap &&
    !["refine", "accept", "complete"].includes(next.action) &&
    !(["implement", "fix"].includes(next.action) && critic.hasObservedProduct)
  )
    return next;
  return {
    ...next,
    criticAdvice: {
      status: "suggested",
      command: `${command} ${critic.transport === "native" ? "--preflight" : "--dispatch"}`,
      guidance:
        "Ask the independent critic for useful feedback on this candidate. If unavailable, use the baseline host review of actual behavior and images; disclose the missing independent review.",
    },
  };
}

type ActiveStatus = Extract<Status, { next: string }>;
function retainedAdvice(critic: ActiveStatus): NonNullable<ProductNext["criticAdvice"]> {
  return {
    status: critic.stopped ? "unavailable" : "feedback",
    guidance: `${critic.stopped ?? "Use the recorded findings to choose the next correction."} Continue the baseline build–observe–fix loop. Actual failures and missing product evidence remain unresolved; missing critic service alone does not block delivery.`,
    command: critic.recovery?.command,
    findings: "findings" in critic ? critic.findings : [],
    evidenceRequest: critic.evidenceRequest,
    limitations: "advice" in critic ? critic.advice?.limitations : undefined,
    comparisons: "comparisons" in critic ? critic.comparisons : [],
  };
}
