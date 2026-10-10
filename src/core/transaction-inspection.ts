import { setTimeout as delay } from "node:timers/promises";
import { inspectFileTransactions, type TransactionInspection } from "./file-transaction.js";
import { ok, type Result } from "./result.js";
import { inspectStateLock } from "./state-lock.js";

/** A prepared journal is interrupted only after ruling out a live writer and a completed save. */
export async function inspectSettledTransactions(
  root: string,
  timeoutMs = 1500,
): Promise<Result<TransactionInspection & { saving: boolean }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let transactions = await inspectFileTransactions(root);
    if (!transactions.ok) return transactions;
    if (!transactions.value.pending.length) return ok({ ...transactions.value, saving: false });
    let lock = await inspectStateLock(root);
    if (!lock.ok) return lock;
    if (lock.value.state !== "active") {
      transactions = await inspectFileTransactions(root);
      if (!transactions.ok) return transactions;
      if (!transactions.value.pending.length) return ok({ ...transactions.value, saving: false });
      lock = await inspectStateLock(root);
      if (!lock.ok) return lock;
    }
    const saving = lock.value.state === "active";
    if (!saving || Date.now() >= deadline) return ok({ ...transactions.value, saving });
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}
