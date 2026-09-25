export interface RecoveryCheck<T> {
  readonly label: string;
  readonly sample: () => T | Promise<T>;
  readonly advance: () => unknown | Promise<unknown>;
  readonly recovered: (state: T) => boolean | Promise<boolean>;
  readonly maxSteps: number;
  readonly timeoutMs?: number;
}

/** Bound both simulation steps and elapsed time. The caller owns cleanup of in-flight I/O. */
export async function assertRecovery<T>(
  check: RecoveryCheck<T>,
): Promise<{ steps: number; state: T }> {
  if (!Number.isSafeInteger(check.maxSteps) || check.maxSteps < 0)
    throw new Error("maxSteps must be a nonnegative safe integer");
  const timeoutMs = check.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("timeoutMs must be positive and fit a timer");
  let expired = false;
  const expiresAt = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error(`${check.label}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  function checkDeadline() {
    if (expired || Date.now() >= expiresAt) throw new Error(`${check.label}: timed out`);
  }
  async function run() {
    for (let steps = 0; steps <= check.maxSteps; steps++) {
      const state = await check.sample();
      checkDeadline();
      const recovered = await check.recovered(state);
      checkDeadline();
      if (typeof recovered !== "boolean") throw new Error("recovered must resolve to a boolean");
      if (recovered) return { steps, state };
      if (steps < check.maxSteps) await check.advance();
      checkDeadline();
    }
    throw new Error(`${check.label}: did not recover within ${check.maxSteps} steps`);
  }
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function assertFiniteState(values: Readonly<Record<string, number>>): void {
  for (const [name, value] of Object.entries(values))
    if (!Number.isFinite(value))
      throw new Error(`${name}: expected a finite number, received ${value}`);
}

export interface TrajectoryPoint {
  readonly x: number;
  readonly y: number;
}

/** Compare positions sampled at identical times, in the same coordinate system. */
export function assertTrajectoryClose(
  actual: readonly TrajectoryPoint[],
  predicted: readonly TrajectoryPoint[],
  tolerance: number,
): void {
  if (actual.length === 0 || actual.length !== predicted.length)
    throw new Error("Trajectories must be non-empty and have equal sample counts");
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new Error("tolerance must be finite and nonnegative");
  for (let index = 0; index < actual.length; index++) {
    const point = actual[index];
    const prediction = predicted[index];
    if (!point || !prediction) throw new Error(`Missing trajectory sample ${index}`);
    assertFiniteState({
      x: point.x,
      y: point.y,
      predictedX: prediction.x,
      predictedY: prediction.y,
    });
    const error = Math.hypot(point.x - prediction.x, point.y - prediction.y);
    if (error > tolerance)
      throw new Error(`Trajectory sample ${index}: error ${error} exceeds tolerance ${tolerance}`);
  }
}
