import { PRODUCT_NAME } from "../../core/constants.js";
import { type VispError, vispError } from "../../core/errors.js";
import { repositoryRequiredError } from "../../core/git.js";
import { err, ok, type Result } from "../../core/result.js";
import { buildFoundationContext, type FoundationContext, type WorkspaceState } from "../state.js";

export type FoundationState = FoundationContext;

/**
 * The implementation bridge is fail-closed. Context and handoff expose an
 * actionable coding brief, so they must not run before the surface that can
 * enforce it.
 */
export async function requireImplementationFoundation(
  state: WorkspaceState,
  recovery: string,
): Promise<Result<void>> {
  const context = await buildFoundationContext(state);
  if (!context.ok) return context;
  const blocked = implementationFoundationError(context.value, recovery);
  return blocked ? err(blocked) : ok(undefined);
}

/** A feature starts only from a committed, clean project baseline. */
export async function requireFeatureFoundation(
  state: WorkspaceState,
  recovery: string,
): Promise<Result<void>> {
  const context = await buildFoundationContext(state);
  if (!context.ok) return context;
  const blocked = featureFoundationError(context.value, recovery);
  return blocked ? err(blocked) : ok(undefined);
}

export function featureFoundationError(
  context: FoundationState,
  recovery: string,
): VispError | undefined {
  return combinedFoundationError(foundationBlockers(context, recovery, true));
}

export function implementationFoundationError(
  context: FoundationState,
  recovery: string,
): VispError | undefined {
  return combinedFoundationError(foundationBlockers(context, recovery));
}

export interface FoundationBlocker {
  readonly requirement: "repository" | "harness" | "enforcement" | "baseline" | "clean-baseline";
  readonly error: VispError;
}

/** Report every known prerequisite without making one failed check hide the next. */
export function foundationBlockers(
  context: FoundationState,
  recovery: string,
  cleanBaseline = false,
): FoundationBlocker[] {
  const blockers: FoundationBlocker[] = [];
  if (context.repositoryAvailable === false) {
    blockers.push({ requirement: "repository", error: repositoryRequiredError() });
  }
  if (context.harnessInstalled === false) {
    blockers.push({
      requirement: "harness",
      error: vispError(
        "STAGE_BLOCKED",
        "The Visp workflow is unavailable until the selected coding harness is installed",
        { recovery: `${PRODUCT_NAME} install` },
      ),
    });
  }
  if (context.enforcementInstalled === false) {
    blockers.push({
      requirement: "enforcement",
      error: vispError(
        "STAGE_BLOCKED",
        "No installed local hook can enforce task scope; assets-only or CI-only installation cannot authorize coding",
        { recovery: `${PRODUCT_NAME} install` },
      ),
    });
  }
  if (context.hasBaseline === false) {
    blockers.push({
      requirement: "baseline",
      error: vispError(
        "STAGE_BLOCKED",
        "The Visp workflow needs a committed before-tree for scope and evidence checks",
        { recovery: `git commit the project baseline, then ${recovery}` },
      ),
    });
  }
  if (cleanBaseline && (context.changedFiles?.length ?? 0) > 0) {
    blockers.push({
      requirement: "clean-baseline",
      error: vispError(
        "STAGE_BLOCKED",
        "A feature must start from a committed baseline, but the working tree already has changes",
        {
          recovery: `git commit the project baseline, then ${recovery}`,
          details: { changedFiles: context.changedFiles },
        },
      ),
    });
  }
  return blockers;
}

function combinedFoundationError(blockers: readonly FoundationBlocker[]): VispError | undefined {
  const first = blockers[0]?.error;
  if (!first) return undefined;
  return {
    ...first,
    message:
      blockers.length === 1
        ? first.message
        : [
            "Workflow setup is incomplete. Resolve these known requirements together:",
            ...blockers.map(
              ({ requirement, error }) =>
                `- ${requirement}: ${error.message} Recovery: ${error.recovery}`,
            ),
            "Complete installation before committing the reviewed project baseline.",
          ].join("\n"),
    details: {
      ...first.details,
      mayEdit: false,
      blockers: blockers.map(({ requirement, error }) => ({
        requirement,
        message: error.message,
        recovery: error.recovery,
        ...error.details,
      })),
    },
  };
}
