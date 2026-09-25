import {
  type EvidenceReceipt,
  evidenceReceiptSchema,
  type OutputSurface,
} from "../workflow/artifacts/evidence-contract.js";
import { bounded } from "./deadline.js";

export interface EvidenceReference {
  readonly criterion: string;
  readonly id: string;
  readonly surface: OutputSurface;
}

export interface CheckpointCheck<T> extends EvidenceReference {
  readonly sample: (signal: AbortSignal) => T | Promise<T>;
  readonly verify: (actual: T) => boolean | Promise<boolean>;
  readonly timeoutMs?: number;
}

/** Call with the actual output, not an unrelated status flag. Semantics remain the test author's responsibility. */
export async function assertCheckpoint<T>(check: CheckpointCheck<T>): Promise<T> {
  const receipt = evidenceReceiptSchema.parse({
    criterion: check.criterion,
    id: check.id,
    surface: check.surface,
    kind: "checkpoint",
    outcome: "passed",
    samples: 1,
  });
  return bounded(check.id, check.timeoutMs, async (signal) => {
    const sample = structuredClone(await check.sample(signal));
    signal.throwIfAborted();
    const passed = await check.verify(structuredClone(sample));
    signal.throwIfAborted();
    if (passed !== true)
      throw new Error(`${check.id}: output checkpoint did not pass a boolean assertion`);
    emitEvidence(receipt);
    return sample;
  });
}

export function emitEvidence(receipt: EvidenceReceipt): void {
  console.log(`VISP_EVIDENCE ${JSON.stringify(evidenceReceiptSchema.parse(receipt))}`);
}
