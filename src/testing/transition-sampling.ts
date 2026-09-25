import type { TransitionStep } from "./transitions.js";

const MAX_SAMPLES = 1_000;

export function validateSampling<T>(step: TransitionStep<T>): void {
  if (
    step.sampleIntervalMs !== undefined &&
    (!Number.isFinite(step.sampleIntervalMs) ||
      step.sampleIntervalMs <= 0 ||
      step.sampleIntervalMs > 60_000)
  )
    throw new Error("sampleIntervalMs must be positive and at most 60000");
  if (
    step.minimumDuringSamples !== undefined &&
    (!Number.isSafeInteger(step.minimumDuringSamples) ||
      step.minimumDuringSamples < 1 ||
      step.minimumDuringSamples > MAX_SAMPLES)
  )
    throw new Error(`minimumDuringSamples must be an integer from 1 to ${MAX_SAMPLES}`);
  if (
    !step.during &&
    (step.sampleIntervalMs !== undefined || step.minimumDuringSamples !== undefined)
  )
    throw new Error("Sampling options require a during invariant");
}

/** Samples actual execution; never advances an application's clock or injects state. */
export async function sampleDuringAction<T>(
  step: TransitionStep<T>,
  before: T,
  sample: (signal: AbortSignal) => T | Promise<T>,
  signal: AbortSignal,
): Promise<T[]> {
  if (!step.during) {
    await step.act(signal);
    return [];
  }
  let settled = false;
  let failure: { error: unknown } | undefined;
  // Observe rejection immediately, even when a concurrent sample is still pending.
  const action = Promise.resolve()
    .then(() => step.act(signal))
    .then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        failure = { error };
        settled = true;
      },
    );
  await Promise.resolve();
  const observations: T[] = [];
  while (!settled) {
    signal.throwIfAborted();
    const current = structuredClone(await sample(signal));
    // A sample finishing after the action is an endpoint, not intermediate evidence.
    await Promise.resolve();
    if (settled) break;
    const passed = await step.during(structuredClone(before), structuredClone(current));
    signal.throwIfAborted();
    if (typeof passed !== "boolean")
      throw new Error(`${step.name}: during verification must return a boolean`);
    if (!passed)
      throw new Error(`Invariant failed during ${step.name} at sample ${observations.length + 1}`);
    observations.push(current);
    if (observations.length >= MAX_SAMPLES)
      throw new Error(`${step.name}: intermediate sample limit exceeded`);
    await delay(step.sampleIntervalMs ?? 16, signal);
  }
  await action;
  if (failure) throw failure.error;
  signal.throwIfAborted();
  if (observations.length < (step.minimumDuringSamples ?? 2))
    throw new Error(
      `${step.name}: insufficient intermediate samples; hold the interaction long enough to observe it`,
    );
  return observations;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
