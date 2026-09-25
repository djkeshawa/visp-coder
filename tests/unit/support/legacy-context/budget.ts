/** Historical test-fixture builder; never used by the product workflow. */
import { describeCommand } from "../../../../src/core/exec.js";
import type { ContextPack } from "../../../../src/workflow/artifacts/context.js";
import type { Task } from "../../../../src/workflow/artifacts/tasks.js";
import { renderHandoff } from "./handoff.js";
import { estimateContextResponseTokens, estimateDeliveredPackTokens } from "./render.js";
import { isEssentialContext } from "./select.js";
import { estimateTokens } from "./snippets.js";

/** Budget each complete delivery, rather than summing file estimates with fixed overhead. */
export function estimateContextDelivery(pack: ContextPack, task: Task, snippets: boolean): number {
  const handoff = renderHandoff({
    feature: pack.feature,
    goal: pack.contract?.featureGoal ?? pack.goal,
    task,
    validationCommands:
      pack.contract?.validationCommands ?? task.validationCommands.map(describeCommand),
    pack,
  });
  return Math.max(
    estimateDeliveredPackTokens(pack, snippets),
    estimateContextResponseTokens(pack, snippets),
    estimateTokens(handoff),
  );
}

/** Essential inputs survive; an impossible budget is explicit, never silently truncated. */
export function fitContextBudget(pack: ContextPack, task: Task, snippets: boolean): ContextPack {
  let fitted = priceContext(
    { ...pack, omissionPreviewLimit: 8, budgetStatus: "within-budget" },
    task,
    snippets,
  );
  while (fitted.estimatedTokens > fitted.tokenBudget) {
    if (fitted.omitted.length > 0 && (fitted.omissionPreviewLimit ?? 0) > 0) {
      fitted = priceContext(
        { ...fitted, omissionPreviewLimit: (fitted.omissionPreviewLimit ?? 0) - 1 },
        task,
        snippets,
      );
      continue;
    }
    const index = fitted.files.findLastIndex((file) => !isEssentialContext(file.reason));
    if (index < 0) {
      fitted = { ...fitted, budgetStatus: "essential-overflow" };
      break;
    }
    if (fitted.omissionPreviewLimit === 0) {
      return fitOptionalPrefix(fitted, task, snippets);
    }
    const file = fitted.files[index];
    if (!file) break;
    fitted = {
      ...fitted,
      files: fitted.files.filter((_, fileIndex) => fileIndex !== index),
      omitted: [
        {
          path: file.path,
          reason: file.reason,
          detail: `over complete delivery budget (~${file.estimatedTokens} file tokens)`,
        },
        ...fitted.omitted,
      ],
    };
    fitted = priceContext(fitted, task, snippets);
  }
  return priceContext(fitted, task, snippets);
}

/** With previews hidden, removing a file saves more than the omission count can add. */
function fitOptionalPrefix(pack: ContextPack, task: Task, snippets: boolean): ContextPack {
  const optional = pack.files.filter((file) => !isEssentialContext(file.reason));
  const withPrefix = (count: number): ContextPack => {
    const removed = new Set(optional.slice(count));
    return priceContext(
      {
        ...pack,
        files: pack.files.filter((file) => !removed.has(file)),
        omitted: [
          ...optional.slice(count).map((file) => ({
            path: file.path,
            reason: file.reason,
            detail: `over complete delivery budget (~${file.estimatedTokens} file tokens)`,
          })),
          ...pack.omitted,
        ],
      },
      task,
      snippets,
    );
  };

  let best = withPrefix(0);
  if (best.estimatedTokens > best.tokenBudget) {
    return priceContext({ ...best, budgetStatus: "essential-overflow" }, task, snippets);
  }
  let low = 1;
  let high = optional.length - 1;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = withPrefix(count);
    if (candidate.estimatedTokens <= candidate.tokenBudget) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return priceContext(best, task, snippets);
}

function priceContext(pack: ContextPack, task: Task, snippets: boolean): ContextPack {
  let fitted = pack;
  // The cost and overflow labels themselves are part of the delivered shape.
  for (let pass = 0; pass < 3; pass += 1) {
    fitted = { ...fitted, estimatedTokens: estimateContextDelivery(fitted, task, snippets) };
  }
  return fitted;
}
