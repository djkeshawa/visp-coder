import { bounded } from "./deadline.js";
import { type EvidenceReference, emitEvidence } from "./evidence.js";
import { sampleDuringAction, validateSampling } from "./transition-sampling.js";

export interface TransitionStep<T> {
  readonly name: string;
  readonly act: (signal: AbortSignal) => unknown | Promise<unknown>;
  readonly verify: (before: T, after: T) => boolean | Promise<boolean>;
  /** Optional invariant sampled while the production action is still in progress. */
  readonly during?: (before: T, current: T) => boolean | Promise<boolean>;
  readonly sampleIntervalMs?: number;
  readonly minimumDuringSamples?: number;
  readonly evidence?: EvidenceReference;
}

export interface TransitionContract<T> {
  readonly label: string;
  /** Return cloneable observations, not live DOM nodes or application handles. */
  readonly sample: (signal: AbortSignal) => T | Promise<T>;
  readonly steps: readonly TransitionStep<T>[];
  readonly timeoutMs?: number;
}

/** Drives caller-owned production actions and checks each transition, including resource accounting. */
export async function assertTransitions<T>(
  contract: TransitionContract<T>,
): Promise<Array<{ name: string; before: T; during: T[]; after: T }>> {
  if (!contract.steps.length || contract.steps.length > 100)
    throw new Error("Transitions require a non-empty sequence of at most 100 steps");
  for (const step of contract.steps) validateSampling(step);
  return bounded(contract.label, contract.timeoutMs, async (signal) => {
    const observations: Array<{ name: string; before: T; during: T[]; after: T }> = [];
    for (const step of contract.steps) {
      signal.throwIfAborted();
      const before = structuredClone(await contract.sample(signal));
      signal.throwIfAborted();
      const during = await sampleDuringAction(step, before, contract.sample, signal);
      signal.throwIfAborted();
      const after = structuredClone(await contract.sample(signal));
      signal.throwIfAborted();
      const passed = await step.verify(structuredClone(before), structuredClone(after));
      signal.throwIfAborted();
      if (typeof passed !== "boolean")
        throw new Error(`${step.name}: verification must return a boolean`);
      if (!passed)
        throw new Error(`${contract.label}: transition ${step.name} violated its contract`);
      if (step.evidence)
        emitEvidence({
          ...step.evidence,
          kind: "checkpoint",
          outcome: "passed",
          samples: step.during ? during.length : 1,
        });
      observations.push({ name: step.name, before, during, after });
    }
    return observations;
  });
}

export interface BehaviorSensitivityCheck {
  readonly label: string;
  readonly baseline: (signal: AbortSignal) => boolean | Promise<boolean>;
  /** Execute the same expectation against a deliberately changed, still-loadable isolated subject. */
  readonly changed: (signal: AbortSignal) => boolean | Promise<boolean>;
  readonly timeoutMs?: number;
  readonly evidence?: EvidenceReference;
}

export interface SubjectSensitivityCheck<T> {
  readonly label: string;
  readonly baseline: (signal: AbortSignal) => T | Promise<T>;
  readonly changed: (signal: AbortSignal) => T | Promise<T>;
  /** One shared expectation is used for both still-loadable, caller-isolated subjects. */
  readonly verify: (subject: T, signal: AbortSignal) => boolean | Promise<boolean>;
  readonly dispose?: (subject: T) => unknown | Promise<unknown>;
  readonly timeoutMs?: number;
  readonly evidence?: EvidenceReference;
}

/** A crashed setup is not a detected regression. Callers isolate and clean up their own subjects. */
export function assertBehaviorSensitive(check: BehaviorSensitivityCheck): Promise<void>;
export function assertBehaviorSensitive<T>(check: SubjectSensitivityCheck<T>): Promise<void>;
export async function assertBehaviorSensitive<T>(
  check: BehaviorSensitivityCheck | SubjectSensitivityCheck<T>,
): Promise<void> {
  await bounded(check.label, check.timeoutMs, async (signal) => {
    const evaluate = (variant: "baseline" | "changed") =>
      "verify" in check ? checkSubject(check, variant, signal) : check[variant](signal);
    if ((await evaluate("baseline")) !== true)
      throw new Error(`${check.label}: baseline did not pass`);
    signal.throwIfAborted();
    const result = await evaluate("changed");
    signal.throwIfAborted();
    if (typeof result !== "boolean")
      throw new Error(`${check.label}: changed check must return a boolean`);
    if (result)
      throw new Error(`${check.label}: verification did not detect changed production behavior`);
    if (check.evidence)
      emitEvidence({
        ...check.evidence,
        kind: "negative-control",
        outcome: "passed",
        baselinePassed: true,
        changedPassed: false,
      });
  });
}

async function checkSubject<T>(
  check: SubjectSensitivityCheck<T>,
  variant: "baseline" | "changed",
  signal: AbortSignal,
): Promise<boolean> {
  const subject = await check[variant](signal);
  try {
    signal.throwIfAborted();
    return await check.verify(subject, signal);
  } finally {
    await check.dispose?.(subject);
  }
}
