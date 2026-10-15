import type { ProductState } from "./model.js";

const TRAIL_LIMITS = { executions: 100, captureRuns: 20, captures: 40 };

export function strings(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) strings(item, into);
  return into;
}

function id(value: unknown): string | undefined {
  return value && typeof value === "object" && "id" in value && typeof value.id === "string"
    ? value.id
    : undefined;
}

/** References from review and repair history always outlive the rolling diagnostic tail. */
export function compactTrail(state: ProductState): ProductState {
  const { executions, captureRuns, captures, ...rest } = state;
  const referenced = strings(rest);
  const latest = new Map<string, string>();
  for (const execution of executions)
    latest.set(`${execution.task ?? "feature"}:${execution.check}`, execution.id);
  const keep = new Set([...referenced, ...latest.values()]);
  const retained = executions.filter(
    (execution, index) =>
      index >= executions.length - TRAIL_LIMITS.executions || keep.has(execution.id),
  );
  const runIds = strings(retained, referenced);
  const runs = captureRuns.filter(
    (run, index) =>
      index >= captureRuns.length - TRAIL_LIMITS.captureRuns || runIds.has(id(run) ?? ""),
  );
  const captureIds = strings(runs, runIds);
  return {
    ...state,
    executions: retained,
    captureRuns: runs,
    captures: captures.filter(
      (capture, index) =>
        index >= captures.length - TRAIL_LIMITS.captures || captureIds.has(id(capture) ?? ""),
    ),
  };
}
